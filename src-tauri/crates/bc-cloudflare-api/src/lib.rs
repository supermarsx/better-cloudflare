//! # bc-cloudflare-api
//!
//! Typed Cloudflare REST API client: zones, DNS record CRUD, bulk create,
//! export (JSON / CSV / BIND), cache purge, zone settings, and DNSSEC.

mod types;

pub use types::*;

use reqwest::{header::CONTENT_LENGTH, Client, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_RETRIES: u32 = 3;
const INITIAL_BACKOFF_MS: u64 = 1000;
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const CLOUDFLARE_API_HOST: &str = "api.cloudflare.com";
pub const DNS_LIST_OPERATION: &str = "dns:list";
const CLOUDFLARE_REQUEST_OPERATION: &str = "cloudflare:request";
const CLOUDFLARE_API_BASE: &str = "https://api.cloudflare.com/client/v4";
const AUTH_OPERATION: &str = "auth:verify_token";
const MAX_PROVIDER_ERRORS: usize = 5;
const MAX_PROVIDER_MESSAGE_LENGTH: usize = 240;
const MAX_RESPONSE_BODY_BYTES: usize = 10 * 1024 * 1024;
const MAX_DNS_PAGE: u32 = 1_000_000;
const MAX_DNS_RECORDS_PER_PAGE: u32 = 5_000;
const MAX_BULK_DNS_RECORDS: usize = 200;
const ZONE_ANALYTICS_OPERATION: &str = "analytics:zone_graphql";
const ZONE_ANALYTICS_GRAPHQL_QUERY: &str = r#"
query ZoneAnalytics($zoneTag: string, $start: Time, $end: Time) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      totals: httpRequests1mGroups(
        limit: 1
        filter: { datetime_geq: $start, datetime_lt: $end }
      ) {
        sum {
          requests
          bytes
          threats
          pageViews
        }
        uniq {
          uniques
        }
      }
      timeseries: httpRequests1mGroups(
        limit: 10000
        orderBy: [datetimeFiveMinutes_ASC]
        filter: { datetime_geq: $start, datetime_lt: $end }
      ) {
        dimensions {
          datetimeFiveMinutes
        }
        sum {
          requests
          bytes
          threats
          pageViews
        }
        uniq {
          uniques
        }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
struct ZoneAnalyticsGraphQlEnvelope {
    data: Option<ZoneAnalyticsGraphQlData>,
}

#[derive(Debug, Deserialize)]
struct ZoneAnalyticsGraphQlData {
    viewer: ZoneAnalyticsGraphQlViewer,
}

#[derive(Debug, Deserialize)]
struct ZoneAnalyticsGraphQlViewer {
    zones: Vec<ZoneAnalyticsGraphQlZone>,
}

#[derive(Debug, Deserialize)]
struct ZoneAnalyticsGraphQlZone {
    totals: Vec<ZoneAnalyticsGraphQlGroup>,
    timeseries: Vec<ZoneAnalyticsGraphQlGroup>,
}

#[derive(Debug, Deserialize)]
struct ZoneAnalyticsGraphQlGroup {
    dimensions: Option<ZoneAnalyticsGraphQlDimensions>,
    sum: ZoneAnalyticsGraphQlSum,
    uniq: ZoneAnalyticsGraphQlUniq,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZoneAnalyticsGraphQlDimensions {
    datetime_five_minutes: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZoneAnalyticsGraphQlSum {
    requests: u64,
    bytes: u64,
    threats: u64,
    page_views: u64,
}

#[derive(Debug, Default, Deserialize)]
struct ZoneAnalyticsGraphQlUniq {
    uniques: u64,
}

struct ZoneAnalyticsErrorContext {
    kind: VerificationFailureKind,
    status: Option<u16>,
    request_id: Option<String>,
    retry_after_secs: Option<u64>,
    provider_errors: Vec<CloudflareProviderError>,
    retryable: bool,
}

fn utc_rfc3339_from_unix_seconds(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let shifted_days = days + 719_468;
    let era = if shifted_days >= 0 {
        shifted_days
    } else {
        shifted_days - 146_096
    } / 146_097;
    let day_of_era = shifted_days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn resolve_zone_analytics_bound(value: &str, now: i64) -> String {
    let offset_seconds = match value.trim() {
        "now" => Some(0),
        "-6h" => Some(6 * 60 * 60),
        "-24h" => Some(24 * 60 * 60),
        "-7d" => Some(7 * 24 * 60 * 60),
        "-30d" => Some(30 * 24 * 60 * 60),
        _ => None,
    };
    offset_seconds.map_or_else(
        || value.trim().to_string(),
        |offset| utc_rfc3339_from_unix_seconds(now.saturating_sub(offset)),
    )
}

fn resolve_zone_analytics_bounds(since: &str, until: &str) -> (String, String) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or(0);
    (
        resolve_zone_analytics_bound(since, now),
        resolve_zone_analytics_bound(until, now),
    )
}

// ── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationFailureKind {
    Authentication,
    RateLimited,
    Provider,
    Network,
    Timeout,
    MalformedResponse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationErrorSource {
    Network,
    Cloudflare,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudflareProviderError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
}

/// Secret-safe structured failure from Cloudflare token verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudflareRequestError {
    pub kind: VerificationFailureKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub source: VerificationErrorSource,
    pub operation: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_errors: Vec<CloudflareProviderError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
    pub remediation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl std::fmt::Display for CloudflareRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Error, Debug)]
pub enum CloudflareError {
    #[error("HTTP error: {0}")]
    HttpError(CloudflareHttpError),
    #[error("API error: {0}")]
    ApiError(String),
    #[error("Authentication failed")]
    AuthFailed,
    #[error("Rate limited after {0} retries")]
    RateLimited(u32),
    #[error("{0}")]
    Verification(Box<CloudflareRequestError>),
    #[error("{0}")]
    Request(Box<CloudflareRequestError>),
    #[error("{0}")]
    ResourceLimit(Box<CloudflareResourceLimitContext>),
    #[error("{0}")]
    Validation(Box<CloudflareValidationError>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceLimitKind {
    ContentLength,
    StreamedBody,
    Collection,
    Allocation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceLimitError {
    pub resource: &'static str,
    pub limit: u64,
    pub actual: Option<u64>,
    pub kind: ResourceLimitKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudflareResourceLimitContext {
    pub limit: ResourceLimitError,
    pub status: Option<u16>,
    pub source: VerificationErrorSource,
    pub operation: String,
    pub retryable: bool,
    pub message: String,
    pub remediation: String,
    pub request_id: Option<String>,
}

impl std::fmt::Display for CloudflareResourceLimitContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudflareValidationError {
    pub field: String,
    pub limit: u64,
    pub actual: Option<u64>,
    pub operation: String,
    pub message: String,
    pub remediation: String,
}

impl std::fmt::Display for CloudflareValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudflareTransportCategory {
    Dns,
    Timeout,
    Connect,
    Other,
}

impl std::fmt::Display for CloudflareTransportCategory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Dns => "dns",
            Self::Timeout => "timeout",
            Self::Connect => "connect",
            Self::Other => "transport",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudflareTransportError {
    pub category: CloudflareTransportCategory,
    pub host: &'static str,
    pub operation: &'static str,
    pub attempt: u32,
    pub max_attempts: u32,
    pub retryable: bool,
    pub remediation: &'static str,
}

impl CloudflareTransportError {
    fn from_reqwest(
        error: &reqwest::Error,
        operation: &'static str,
        attempt: u32,
        max_attempts: u32,
    ) -> Self {
        let (category, retryable, remediation) =
            if let Some(dns_error) = find_dns_resolution_error(error) {
                (
                    CloudflareTransportCategory::Dns,
                    dns_error.retryable,
                    if dns_error.retryable {
                        "Check Windows DNS, VPN, and proxy connectivity, then retry."
                    } else {
                        "Check Windows DNS, VPN, and proxy configuration for the Cloudflare API."
                    },
                )
            } else if error.is_timeout() {
                (
                    CloudflareTransportCategory::Timeout,
                    true,
                    "Check network, VPN, and proxy connectivity, then retry.",
                )
            } else if error.is_connect() {
                (
                    CloudflareTransportCategory::Connect,
                    find_io_error(error).is_some_and(is_retryable_connect_io_error),
                    "Check network, VPN, and proxy connectivity, then retry.",
                )
            } else {
                (
                    CloudflareTransportCategory::Other,
                    false,
                    "Retry the operation; if it persists, review the local diagnostic log.",
                )
            };

        Self {
            category,
            host: CLOUDFLARE_API_HOST,
            operation,
            attempt,
            max_attempts,
            retryable,
            remediation,
        }
    }

    const fn generic(operation: &'static str) -> Self {
        Self {
            category: CloudflareTransportCategory::Other,
            host: CLOUDFLARE_API_HOST,
            operation,
            attempt: 1,
            max_attempts: 1,
            retryable: false,
            remediation: "Retry the operation; if it persists, review the local diagnostic log.",
        }
    }
}

impl std::fmt::Display for CloudflareTransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} failure contacting {} for {} (attempt {}/{}): {}",
            self.category,
            self.host,
            self.operation,
            self.attempt,
            self.max_attempts,
            self.remediation
        )
    }
}

impl std::error::Error for CloudflareTransportError {}

#[derive(Debug)]
struct DnsResolutionError {
    retryable: bool,
    source: Box<dyn std::error::Error + Send + Sync>,
}

impl std::fmt::Display for DnsResolutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("system DNS resolution failed")
    }
}

impl std::error::Error for DnsResolutionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

struct SanitizingResolver {
    inner: std::sync::Arc<dyn reqwest::dns::Resolve>,
}

impl SanitizingResolver {
    fn new(inner: std::sync::Arc<dyn reqwest::dns::Resolve>) -> Self {
        Self { inner }
    }
}

impl std::fmt::Debug for SanitizingResolver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("SanitizingResolver").finish()
    }
}

impl reqwest::dns::Resolve for SanitizingResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let resolving = self.inner.resolve(name);
        Box::pin(async move {
            match resolving.await {
                Ok(addresses) => Ok(addresses),
                Err(source) => {
                    let retryable = is_retryable_resolver_error(source.as_ref());
                    Err(Box::new(DnsResolutionError { retryable, source })
                        as Box<dyn std::error::Error + Send + Sync>)
                }
            }
        })
    }
}

fn find_dns_resolution_error(error: &reqwest::Error) -> Option<&DnsResolutionError> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(source) = current {
        if let Some(dns_error) = source.downcast_ref::<DnsResolutionError>() {
            return Some(dns_error);
        }
        current = source.source();
    }
    None
}

fn find_io_error<'a>(error: &'a (dyn std::error::Error + 'static)) -> Option<&'a std::io::Error> {
    let mut current = Some(error);
    while let Some(source) = current {
        if let Some(io_error) = source.downcast_ref::<std::io::Error>() {
            return Some(io_error);
        }
        current = source.source();
    }
    None
}

fn is_retryable_resolver_error(error: &(dyn std::error::Error + 'static)) -> bool {
    let Some(io_error) = find_io_error(error) else {
        return false;
    };

    #[cfg(windows)]
    if let Some(code) = io_error.raw_os_error() {
        const WSA_TRY_AGAIN: i32 = 11_002;
        const WSA_HOST_NOT_FOUND: i32 = 11_001;
        const WSA_NO_RECOVERY: i32 = 11_003;
        const WSA_NO_DATA: i32 = 11_004;
        match code {
            WSA_TRY_AGAIN => return true,
            WSA_HOST_NOT_FOUND | WSA_NO_RECOVERY | WSA_NO_DATA => return false,
            _ => {}
        }
    }

    matches!(
        io_error.kind(),
        std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::WouldBlock
    )
}

fn is_retryable_connect_io_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::AddrNotAvailable
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::WouldBlock
    )
}

#[derive(Debug)]
struct SystemResolver;

impl reqwest::dns::Resolve for SystemResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?
                .collect::<Vec<_>>();
            Ok(Box::new(addresses.into_iter())
                as Box<dyn Iterator<Item = std::net::SocketAddr> + Send>)
        })
    }
}

fn default_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .dns_resolver(std::sync::Arc::new(SanitizingResolver::new(
            std::sync::Arc::new(SystemResolver),
        )))
        .build()
        .expect("the default Cloudflare HTTP client configuration must be valid")
}

#[derive(Debug, Clone, Copy)]
struct SafeRequestContext {
    operation: &'static str,
    is_idempotent_read: bool,
}

impl SafeRequestContext {
    fn from_builder(builder: &reqwest::RequestBuilder) -> Self {
        let Some(cloned) = builder.try_clone() else {
            return Self::generic();
        };
        let Ok(request) = cloned.build() else {
            return Self::generic();
        };
        let is_idempotent_read =
            request.method() == reqwest::Method::GET || request.method() == reqwest::Method::HEAD;
        let operation = if is_idempotent_read && request.url().path().ends_with("/dns_records") {
            DNS_LIST_OPERATION
        } else {
            CLOUDFLARE_REQUEST_OPERATION
        };
        Self {
            operation,
            is_idempotent_read,
        }
    }

    const fn generic() -> Self {
        Self {
            operation: CLOUDFLARE_REQUEST_OPERATION,
            is_idempotent_read: false,
        }
    }
}

impl std::fmt::Display for ResourceLimitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} exceeded its resource limit of {}",
            self.resource, self.limit
        )?;
        if let Some(actual) = self.actual {
            write!(formatter, " (actual: {actual})")?;
        }
        write!(formatter, " [{:?}]", self.kind)
    }
}

#[cfg(test)]
mod transport_retry_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Debug)]
    struct ScriptedResolver {
        address: SocketAddr,
        transient_failures: usize,
        permanent_failure: bool,
        calls: AtomicUsize,
    }

    impl ScriptedResolver {
        fn transient(address: SocketAddr, failures: usize) -> Self {
            Self {
                address,
                transient_failures: failures,
                permanent_failure: false,
                calls: AtomicUsize::new(0),
            }
        }

        fn permanent() -> Self {
            Self {
                address: SocketAddr::from(([127, 0, 0, 1], 9)),
                transient_failures: 0,
                permanent_failure: true,
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl reqwest::dns::Resolve for ScriptedResolver {
        fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let permanent_failure = self.permanent_failure;
            let transient_failure = call < self.transient_failures;
            let address = self.address;
            Box::pin(async move {
                if permanent_failure || transient_failure {
                    let kind = if permanent_failure {
                        std::io::ErrorKind::NotFound
                    } else {
                        std::io::ErrorKind::TimedOut
                    };
                    return Err(
                        Box::new(std::io::Error::new(kind, "scripted resolver failure"))
                            as Box<dyn std::error::Error + Send + Sync>,
                    );
                }
                Ok(Box::new(std::iter::once(address))
                    as Box<dyn Iterator<Item = SocketAddr> + Send>)
            })
        }
    }

    fn test_client(
        api_base: String,
        resolver: Arc<dyn reqwest::dns::Resolve>,
        max_retries: u32,
    ) -> CloudflareClient {
        let client = reqwest::Client::builder()
            .no_proxy()
            .dns_resolver(Arc::new(SanitizingResolver::new(resolver)))
            .build()
            .expect("test HTTP client should build");
        CloudflareClient::with_client(client, "super-secret-token", None)
            .with_max_retries(max_retries)
            .with_api_base(api_base)
    }

    fn spawn_dns_list_server() -> (SocketAddr, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server should have address");
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("test server should accept");
            let mut request = [0_u8; 4096];
            let bytes_read = stream
                .read(&mut request)
                .expect("request should be readable");
            assert!(bytes_read > 0);

            let body = r#"{"success":true,"result":[]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("response should be writable");
        });
        (address, handle)
    }

    fn transport_context(error: &CloudflareError) -> &CloudflareTransportError {
        match error {
            CloudflareError::HttpError(CloudflareHttpError::Transport(context)) => context,
            other => panic!("expected transport error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn dns_list_recovers_after_transient_resolver_failures() {
        let (address, server) = spawn_dns_list_server();
        let resolver = Arc::new(ScriptedResolver::transient(address, 2));
        let client = test_client(
            format!("http://{CLOUDFLARE_API_HOST}:{}/client/v4", address.port()),
            resolver.clone(),
            3,
        );

        let records = client
            .get_dns_records("zone-sensitive-id", Some(1), Some(100))
            .await
            .expect("the third DNS attempt should reach the local server");

        assert!(records.is_empty());
        assert_eq!(resolver.calls(), 3);
        server.join().expect("test server should stop cleanly");
    }

    #[tokio::test(start_paused = true)]
    async fn transient_dns_failure_stops_at_the_configured_bound() {
        let resolver = Arc::new(ScriptedResolver::transient(
            SocketAddr::from(([127, 0, 0, 1], 9)),
            usize::MAX,
        ));
        let client = test_client(
            format!("http://{CLOUDFLARE_API_HOST}:9/client/v4"),
            resolver.clone(),
            2,
        );

        let error = client
            .get_dns_records("zone-sensitive-id", None, None)
            .await
            .expect_err("transient DNS failures should eventually be exhausted");
        let rendered = error.to_string();
        let context = transport_context(&error);

        assert_eq!(resolver.calls(), 3);
        assert_eq!(context.category, CloudflareTransportCategory::Dns);
        assert_eq!(context.host, CLOUDFLARE_API_HOST);
        assert_eq!(context.operation, DNS_LIST_OPERATION);
        assert_eq!(context.attempt, 3);
        assert_eq!(context.max_attempts, 3);
        assert!(context.retryable);
        assert!(!rendered.contains("zone-sensitive-id"));
        assert!(!rendered.contains("super-secret-token"));
    }

    #[tokio::test(start_paused = true)]
    async fn permanent_dns_failure_is_not_retried_or_leaked() {
        let resolver = Arc::new(ScriptedResolver::permanent());
        let client = test_client(
            format!("http://{CLOUDFLARE_API_HOST}:9/client/v4"),
            resolver.clone(),
            3,
        );

        let error = client
            .get_dns_records("zone-sensitive-id", None, None)
            .await
            .expect_err("permanent DNS failure should be returned");
        let rendered = error.to_string();
        let context = transport_context(&error);

        assert_eq!(resolver.calls(), 1);
        assert_eq!(context.category, CloudflareTransportCategory::Dns);
        assert_eq!(context.operation, DNS_LIST_OPERATION);
        assert_eq!(context.attempt, 1);
        assert_eq!(context.max_attempts, 4);
        assert!(!context.retryable);
        assert!(!rendered.contains("zone-sensitive-id"));
        assert!(!rendered.contains("super-secret-token"));
        assert!(!rendered.contains("http://"));
    }

    #[tokio::test(start_paused = true)]
    async fn mutation_transport_failure_is_not_retried() {
        let resolver = Arc::new(ScriptedResolver::transient(
            SocketAddr::from(([127, 0, 0, 1], 9)),
            usize::MAX,
        ));
        let client = test_client(
            format!("http://{CLOUDFLARE_API_HOST}:9/client/v4"),
            resolver.clone(),
            3,
        );
        let url = format!("{}/zones/zone-sensitive-id/dns_records", client.api_base);

        let error = client
            .request_with_retry(move |state| state.apply_auth(state.client.post(&url)))
            .await
            .expect_err("mutation transport failure should be returned immediately");
        let context = transport_context(&error);

        assert_eq!(resolver.calls(), 1);
        assert_eq!(context.category, CloudflareTransportCategory::Dns);
        assert_eq!(context.operation, CLOUDFLARE_REQUEST_OPERATION);
        assert_eq!(context.attempt, 1);
        assert_eq!(context.max_attempts, 4);
    }
}

#[cfg(test)]
mod status_retry_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Serve one scripted status per connection, counting every request that
    /// actually reached the server. `retry-after: 0` keeps backoff instant.
    fn spawn_scripted_server(statuses: Vec<u16>) -> (SocketAddr, Arc<AtomicUsize>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server should have address");
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&requests);

        std::thread::spawn(move || {
            for (index, stream) in listener.incoming().enumerate() {
                let Ok(mut stream) = stream else { break };
                let mut buffer = [0_u8; 4096];
                let _ = stream.read(&mut buffer);
                counter.fetch_add(1, Ordering::SeqCst);

                let status = statuses
                    .get(index)
                    .or_else(|| statuses.last())
                    .copied()
                    .unwrap_or(200);
                let body = if status == 200 {
                    r#"{"success":true,"result":{}}"#
                } else {
                    r#"{"success":false,"errors":[]}"#
                };
                let response = format!(
                    "HTTP/1.1 {status} SCRIPTED\r\ncontent-type: application/json\r\nretry-after: 0\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        (address, requests)
    }

    fn scripted_client(address: SocketAddr, max_retries: u32) -> CloudflareClient {
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("test HTTP client should build");
        CloudflareClient::with_client(client, "super-secret-token", None)
            .with_max_retries(max_retries)
            .with_api_base(format!("http://{address}/client/v4"))
    }

    fn dns_records_url(client: &CloudflareClient) -> String {
        format!("{}/zones/zone-sensitive-id/dns_records", client.api_base)
    }

    #[tokio::test]
    async fn server_errors_are_not_retried_for_posts() {
        // A 502 returned after Cloudflare committed the record is
        // indistinguishable from one returned before it, so re-sending the
        // POST risks duplicate DNS records.
        let (address, requests) = spawn_scripted_server(vec![502]);
        let client = scripted_client(address, 3);
        let url = dns_records_url(&client);

        let response = client
            .request_with_retry(move |state| state.apply_auth(state.client.post(&url)))
            .await
            .expect("the server error response should be surfaced, not retried");

        assert_eq!(response.status().as_u16(), 502);
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "a POST must be sent exactly once on a server error"
        );
    }

    #[tokio::test]
    async fn server_errors_are_still_retried_for_reads() {
        let (address, requests) = spawn_scripted_server(vec![503, 503, 200]);
        let client = scripted_client(address, 3);
        let url = dns_records_url(&client);

        let response = client
            .request_with_retry(move |state| state.apply_auth(state.client.get(&url)))
            .await
            .expect("the third read attempt should succeed");

        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            requests.load(Ordering::SeqCst),
            3,
            "an idempotent read must still recover from transient server errors"
        );
    }

    #[tokio::test]
    async fn rate_limits_are_still_retried_for_posts() {
        // A 429 is refused before the request is processed, so re-sending it
        // cannot duplicate a write.
        let (address, requests) = spawn_scripted_server(vec![429, 429, 200]);
        let client = scripted_client(address, 3);
        let url = dns_records_url(&client);

        let response = client
            .request_with_retry(move |state| state.apply_auth(state.client.post(&url)))
            .await
            .expect("the third write attempt should succeed");

        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            requests.load(Ordering::SeqCst),
            3,
            "a rate-limited POST must still be retried"
        );
    }

    #[tokio::test]
    async fn exhausted_post_rate_limits_still_report_a_rate_limit() {
        let (address, requests) = spawn_scripted_server(vec![429]);
        let client = scripted_client(address, 2);
        let url = format!("{}/zones/zone-sensitive-id/purge_cache", client.api_base);

        let error = client
            .request_with_retry(move |state| state.apply_auth(state.client.post(&url)))
            .await
            .expect_err("exhausted rate limits should be an error");

        assert!(matches!(error, CloudflareError::RateLimited(_)));
        assert_eq!(requests.load(Ordering::SeqCst), 3);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudflareHttpError {
    Transport(CloudflareTransportError),
    ResourceLimit(ResourceLimitError),
}

impl From<String> for CloudflareHttpError {
    fn from(_message: String) -> Self {
        Self::Transport(CloudflareTransportError::generic(
            CLOUDFLARE_REQUEST_OPERATION,
        ))
    }
}

impl std::fmt::Display for CloudflareHttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(context) => context.fmt(formatter),
            Self::ResourceLimit(context) => context.fmt(formatter),
        }
    }
}

impl CloudflareError {
    fn http(_error: impl std::fmt::Display) -> Self {
        Self::HttpError(CloudflareHttpError::Transport(
            CloudflareTransportError::generic(CLOUDFLARE_REQUEST_OPERATION),
        ))
    }

    fn transport(
        error: reqwest::Error,
        operation: &'static str,
        attempt: u32,
        max_attempts: u32,
    ) -> Self {
        Self::HttpError(CloudflareHttpError::Transport(
            CloudflareTransportError::from_reqwest(&error, operation, attempt, max_attempts),
        ))
    }

    fn resource_limit(context: ResourceLimitError) -> Self {
        Self::HttpError(CloudflareHttpError::ResourceLimit(context))
    }

    pub fn resource_limit_context(&self) -> Option<&ResourceLimitError> {
        match self {
            Self::HttpError(CloudflareHttpError::ResourceLimit(context)) => Some(context),
            Self::ResourceLimit(context) => Some(&context.limit),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct DnsResponseMetadata {
    status: u16,
    request_id: Option<String>,
}

fn dns_request_error(context: CloudflareRequestError) -> CloudflareError {
    CloudflareError::Request(Box::new(context))
}

fn dns_http_request_error(
    status: u16,
    retry_after_secs: Option<u64>,
    request_id: Option<String>,
    provider_errors: Vec<CloudflareProviderError>,
) -> CloudflareError {
    let (kind, message, retryable, remediation) = match status {
        401 => (
            VerificationFailureKind::Authentication,
            "Cloudflare rejected the saved credentials for the DNS records request.",
            false,
            "Verify the saved Cloudflare credentials and try again.",
        ),
        403 => (
            VerificationFailureKind::Authentication,
            "Cloudflare denied access to the requested DNS records.",
            false,
            "Grant the saved credentials DNS read access for this zone and try again.",
        ),
        408 => (
            VerificationFailureKind::Timeout,
            "Cloudflare timed out while processing the DNS records request.",
            true,
            "Retry the request when Cloudflare connectivity is stable.",
        ),
        429 => (
            VerificationFailureKind::RateLimited,
            "Cloudflare rate limited the DNS records request.",
            true,
            "Wait for the retry interval before requesting DNS records again.",
        ),
        400..=499 => (
            VerificationFailureKind::Provider,
            "Cloudflare rejected the DNS records request.",
            false,
            "Review the Cloudflare account and zone configuration before retrying.",
        ),
        500..=599 => (
            VerificationFailureKind::Provider,
            "Cloudflare could not complete the DNS records request.",
            true,
            "Retry the request after Cloudflare service recovers.",
        ),
        _ => (
            VerificationFailureKind::Provider,
            "Cloudflare returned an unexpected DNS records response status.",
            false,
            "Retry the request and review Cloudflare service status if it persists.",
        ),
    };

    dns_request_error(CloudflareRequestError {
        kind,
        message: message.to_string(),
        status: Some(status),
        source: VerificationErrorSource::Cloudflare,
        operation: DNS_LIST_OPERATION.to_string(),
        retryable,
        provider_errors,
        retry_after_secs: retry_after_secs.map(|seconds| seconds.min(MAX_RETRY_DELAY.as_secs())),
        remediation: remediation.to_string(),
        request_id: request_id.as_deref().and_then(sanitize_request_id),
    })
}

fn dns_provider_code(value: &Value) -> Option<String> {
    if let Some(code) = value.as_u64() {
        return Some(code.to_string());
    }
    value.as_str().and_then(|code| {
        let code = code.trim();
        if code.is_empty()
            || code.len() > 16
            || !code.chars().all(|character| character.is_ascii_digit())
        {
            None
        } else {
            Some(code.to_string())
        }
    })
}

fn dns_provider_errors(body: &[u8], status: u16) -> Vec<CloudflareProviderError> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    let Some(errors) = value.get("errors").and_then(Value::as_array) else {
        return Vec::new();
    };
    let message = match status {
        401 => "Cloudflare reported an authentication error.",
        403 => "Cloudflare reported an authorization error.",
        408 => "Cloudflare reported a request timeout.",
        429 => "Cloudflare reported a rate limit.",
        400..=499 => "Cloudflare rejected the request.",
        500..=599 => "Cloudflare reported a server error.",
        _ => "Cloudflare reported a provider error.",
    };

    errors
        .iter()
        .take(MAX_PROVIDER_ERRORS)
        .filter_map(|error| {
            let code = error.get("code").and_then(dns_provider_code)?;
            Some(CloudflareProviderError {
                code: Some(code),
                message: message.to_string(),
            })
        })
        .collect()
}

fn dns_response_request_id(response: &Response) -> Option<String> {
    response
        .headers()
        .get("cf-ray")
        .and_then(|value| value.to_str().ok())
        .and_then(sanitize_request_id)
}

async fn dns_status_error(response: Response) -> CloudflareError {
    let status = response.status().as_u16();
    let retry_after_secs = parse_retry_after_secs(response.headers());
    let request_id = dns_response_request_id(&response);
    let provider_errors = match read_bounded_response_body(response, MAX_RESPONSE_BODY_BYTES).await
    {
        Ok(body) => dns_provider_errors(&body, status),
        Err(_) => Vec::new(),
    };
    dns_http_request_error(status, retry_after_secs, request_id, provider_errors)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DnsMutationResponseKind {
    Success,
    HttpFailure,
    ProviderFailure,
    Malformed,
}

fn classify_dns_mutation_response(status: u16, json: Option<&Value>) -> DnsMutationResponseKind {
    if !(200..300).contains(&status) {
        return DnsMutationResponseKind::HttpFailure;
    }

    match json.and_then(|value| value.get("success")) {
        Some(Value::Bool(true)) => DnsMutationResponseKind::Success,
        Some(Value::Bool(false)) => DnsMutationResponseKind::ProviderFailure,
        _ => DnsMutationResponseKind::Malformed,
    }
}

async fn read_dns_mutation_response(
    response: Response,
) -> Result<(Value, DnsResponseMetadata), CloudflareError> {
    let status = response.status().as_u16();
    if classify_dns_mutation_response(status, None) == DnsMutationResponseKind::HttpFailure {
        return Err(dns_status_error(response).await);
    }

    let retry_after_secs = parse_retry_after_secs(response.headers());
    let request_id = dns_response_request_id(&response);
    let (json, metadata) = read_dns_success_response(response).await?;

    match classify_dns_mutation_response(status, Some(&json)) {
        DnsMutationResponseKind::Success => Ok((json, metadata)),
        DnsMutationResponseKind::ProviderFailure => {
            let provider_errors = serde_json::to_vec(&json)
                .map(|body| dns_provider_errors(&body, status))
                .unwrap_or_default();
            Err(dns_http_request_error(
                status,
                retry_after_secs,
                request_id,
                provider_errors,
            ))
        }
        DnsMutationResponseKind::Malformed => Err(dns_malformed_response(&metadata)),
        DnsMutationResponseKind::HttpFailure => unreachable!("HTTP status checked before body"),
    }
}

fn dns_malformed_response(metadata: &DnsResponseMetadata) -> CloudflareError {
    dns_request_error(CloudflareRequestError {
        kind: VerificationFailureKind::MalformedResponse,
        message: "Cloudflare returned a malformed DNS records response.".to_string(),
        status: Some(metadata.status),
        source: VerificationErrorSource::Cloudflare,
        operation: DNS_LIST_OPERATION.to_string(),
        retryable: false,
        provider_errors: vec![CloudflareProviderError {
            code: Some("malformed_response".to_string()),
            message: "The DNS records response did not match the expected format.".to_string(),
        }],
        retry_after_secs: None,
        remediation:
            "Retry the request and review Cloudflare service status if the response remains malformed."
                .to_string(),
        request_id: metadata.request_id.clone(),
    })
}

fn dns_response_stream_error(
    error: reqwest::Error,
    metadata: &DnsResponseMetadata,
) -> CloudflareError {
    let transport = CloudflareTransportError::from_reqwest(&error, DNS_LIST_OPERATION, 1, 1);
    let kind = if transport.category == CloudflareTransportCategory::Timeout {
        VerificationFailureKind::Timeout
    } else {
        VerificationFailureKind::Network
    };
    dns_request_error(CloudflareRequestError {
        kind,
        message: "The Cloudflare DNS records response was interrupted.".to_string(),
        status: Some(metadata.status),
        source: VerificationErrorSource::Network,
        operation: DNS_LIST_OPERATION.to_string(),
        retryable: transport.retryable,
        provider_errors: vec![CloudflareProviderError {
            code: Some("transport_category".to_string()),
            message: transport.category.to_string(),
        }],
        retry_after_secs: None,
        remediation: transport.remediation.to_string(),
        request_id: metadata.request_id.clone(),
    })
}

fn dns_resource_limit_error(
    limit: ResourceLimitError,
    metadata: &DnsResponseMetadata,
) -> CloudflareError {
    CloudflareError::ResourceLimit(Box::new(CloudflareResourceLimitContext {
        limit,
        status: Some(metadata.status),
        source: VerificationErrorSource::Cloudflare,
        operation: DNS_LIST_OPERATION.to_string(),
        retryable: false,
        message: "The Cloudflare DNS records response exceeded a local safety limit.".to_string(),
        remediation: "Request a smaller DNS records page and try again.".to_string(),
        request_id: metadata.request_id.clone(),
    }))
}

fn dns_validation_error(error: CloudflareError) -> CloudflareError {
    match error {
        CloudflareError::HttpError(CloudflareHttpError::ResourceLimit(limit)) => {
            CloudflareError::Validation(Box::new(CloudflareValidationError {
                field: limit.resource.to_string(),
                limit: limit.limit,
                actual: limit.actual,
                operation: DNS_LIST_OPERATION.to_string(),
                message: "The DNS records pagination value is outside the supported range."
                    .to_string(),
                remediation: "Use a page number and page size within the supported limits."
                    .to_string(),
            }))
        }
        other => other,
    }
}

fn dns_response_error(error: CloudflareError, metadata: &DnsResponseMetadata) -> CloudflareError {
    match error {
        CloudflareError::HttpError(CloudflareHttpError::ResourceLimit(limit)) => {
            dns_resource_limit_error(limit, metadata)
        }
        _ => dns_malformed_response(metadata),
    }
}

async fn read_dns_success_response(
    response: Response,
) -> Result<(Value, DnsResponseMetadata), CloudflareError> {
    let metadata = DnsResponseMetadata {
        status: response.status().as_u16(),
        request_id: dns_response_request_id(&response),
    };
    let body = match read_bounded_response_body(response, MAX_RESPONSE_BODY_BYTES).await {
        Ok(body) => body,
        Err(ResponseBodyReadError::ResourceLimit(limit)) => {
            return Err(dns_resource_limit_error(limit, &metadata));
        }
        Err(ResponseBodyReadError::Stream(error)) => {
            return Err(dns_response_stream_error(error, &metadata));
        }
    };
    let json = serde_json::from_slice(&body).map_err(|_| dns_malformed_response(&metadata))?;
    Ok((json, metadata))
}

#[cfg(test)]
mod dns_provider_semantics_tests {
    use super::*;

    fn request_context(error: CloudflareError) -> CloudflareRequestError {
        match error {
            CloudflareError::Request(context) => *context,
            other => panic!("expected structured request error, got {other:?}"),
        }
    }

    #[test]
    fn dns_http_status_matrix_preserves_safe_semantics() {
        for (status, expected_kind, retryable) in [
            (401, VerificationFailureKind::Authentication, false),
            (403, VerificationFailureKind::Authentication, false),
            (408, VerificationFailureKind::Timeout, true),
            (429, VerificationFailureKind::RateLimited, true),
            (400, VerificationFailureKind::Provider, false),
            (404, VerificationFailureKind::Provider, false),
            (500, VerificationFailureKind::Provider, true),
            (503, VerificationFailureKind::Provider, true),
        ] {
            let context = request_context(dns_http_request_error(
                status,
                Some(45),
                Some("safe-ray-id".to_string()),
                Vec::new(),
            ));
            assert_eq!(context.kind, expected_kind);
            assert_eq!(context.status, Some(status));
            assert_eq!(context.source, VerificationErrorSource::Cloudflare);
            assert_eq!(context.operation, DNS_LIST_OPERATION);
            assert_eq!(context.retryable, retryable);
            assert_eq!(context.retry_after_secs, Some(30));
            assert_eq!(context.request_id.as_deref(), Some("safe-ray-id"));
        }
    }

    #[test]
    fn dns_provider_details_keep_codes_but_redact_messages() {
        let body = br#"{"errors":[{"code":10000,"message":"https://proxy.internal/zones/zone-secret?api_token=token-secret"},{"code":"not-a-number","message":"token-secret"}]}"#;
        let provider_errors = dns_provider_errors(body, 401);
        assert_eq!(provider_errors.len(), 1);
        assert_eq!(provider_errors[0].code.as_deref(), Some("10000"));
        assert_eq!(
            provider_errors[0].message,
            "Cloudflare reported an authentication error."
        );

        let rendered = format!(
            "{:?}",
            dns_http_request_error(401, None, None, provider_errors)
        );
        for forbidden in ["proxy.internal", "zone-secret", "token-secret", "https://"] {
            assert!(!rendered.contains(forbidden));
        }
    }

    #[test]
    fn malformed_response_and_resource_limit_are_not_transport_errors() {
        let metadata = DnsResponseMetadata {
            status: 200,
            request_id: Some("safe-ray-id".to_string()),
        };
        let malformed = request_context(dns_malformed_response(&metadata));
        assert_eq!(malformed.kind, VerificationFailureKind::MalformedResponse);
        assert_eq!(malformed.status, Some(200));
        assert!(!malformed.retryable);

        let error = dns_resource_limit_error(
            ResourceLimitError {
                resource: "Cloudflare HTTP response body",
                limit: 1024,
                actual: Some(2048),
                kind: ResourceLimitKind::ContentLength,
            },
            &metadata,
        );
        match error {
            CloudflareError::ResourceLimit(context) => {
                assert_eq!(context.status, Some(200));
                assert_eq!(context.limit.limit, 1024);
                assert_eq!(context.limit.actual, Some(2048));
                assert_eq!(context.request_id.as_deref(), Some("safe-ray-id"));
            }
            other => panic!("expected structured resource limit, got {other:?}"),
        }
    }

    #[test]
    fn dns_pagination_limit_becomes_client_validation() {
        let error = dns_validation_error(CloudflareError::resource_limit(ResourceLimitError {
            resource: "DNS records per page",
            limit: 5000,
            actual: Some(5001),
            kind: ResourceLimitKind::Collection,
        }));
        match error {
            CloudflareError::Validation(context) => {
                assert_eq!(context.field, "DNS records per page");
                assert_eq!(context.limit, 5000);
                assert_eq!(context.actual, Some(5001));
                assert_eq!(context.operation, DNS_LIST_OPERATION);
            }
            other => panic!("expected structured validation error, got {other:?}"),
        }
    }
}

#[derive(Debug)]
enum ResponseBodyReadError {
    ResourceLimit(ResourceLimitError),
    Stream(reqwest::Error),
}

impl From<ResponseBodyReadError> for CloudflareError {
    fn from(error: ResponseBodyReadError) -> Self {
        match error {
            ResponseBodyReadError::ResourceLimit(context) => Self::resource_limit(context),
            ResponseBodyReadError::Stream(error) => Self::http(error),
        }
    }
}

async fn read_bounded_response_body(
    mut response: Response,
    limit: usize,
) -> Result<Vec<u8>, ResponseBodyReadError> {
    const RESOURCE: &str = "Cloudflare HTTP response body";

    let limit_u64 = u64::try_from(limit).unwrap_or(u64::MAX);
    let declared_length = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared_length.is_some_and(|length| length > limit_u64) {
        return Err(ResponseBodyReadError::ResourceLimit(ResourceLimitError {
            resource: RESOURCE,
            limit: limit_u64,
            actual: declared_length,
            kind: ResourceLimitKind::ContentLength,
        }));
    }

    let initial_capacity = declared_length
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0);
    let mut body = Vec::new();
    body.try_reserve_exact(initial_capacity).map_err(|_| {
        ResponseBodyReadError::ResourceLimit(ResourceLimitError {
            resource: RESOURCE,
            limit: limit_u64,
            actual: declared_length,
            kind: ResourceLimitKind::Allocation,
        })
    })?;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(ResponseBodyReadError::Stream)?
    {
        let new_length = body.len().checked_add(chunk.len()).ok_or_else(|| {
            ResponseBodyReadError::ResourceLimit(ResourceLimitError {
                resource: RESOURCE,
                limit: limit_u64,
                actual: None,
                kind: ResourceLimitKind::StreamedBody,
            })
        })?;
        if new_length > limit {
            return Err(ResponseBodyReadError::ResourceLimit(ResourceLimitError {
                resource: RESOURCE,
                limit: limit_u64,
                actual: u64::try_from(new_length).ok(),
                kind: ResourceLimitKind::StreamedBody,
            }));
        }
        body.try_reserve_exact(chunk.len()).map_err(|_| {
            ResponseBodyReadError::ResourceLimit(ResourceLimitError {
                resource: RESOURCE,
                limit: limit_u64,
                actual: u64::try_from(new_length).ok(),
                kind: ResourceLimitKind::Allocation,
            })
        })?;
        body.extend_from_slice(&chunk);
    }

    Ok(body)
}

async fn read_json_response<T: DeserializeOwned>(response: Response) -> Result<T, CloudflareError> {
    let body = read_bounded_response_body(response, MAX_RESPONSE_BODY_BYTES).await?;
    serde_json::from_slice(&body).map_err(CloudflareError::http)
}

fn check_collection_limit(
    resource: &'static str,
    actual: usize,
    limit: usize,
) -> Result<(), CloudflareError> {
    if actual <= limit {
        return Ok(());
    }
    Err(CloudflareError::resource_limit(ResourceLimitError {
        resource,
        limit: u64::try_from(limit).unwrap_or(u64::MAX),
        actual: u64::try_from(actual).ok(),
        kind: ResourceLimitKind::Collection,
    }))
}

fn try_reserve_exact<T>(
    values: &mut Vec<T>,
    additional: usize,
    resource: &'static str,
    limit: usize,
) -> Result<(), CloudflareError> {
    values.try_reserve_exact(additional).map_err(|_| {
        CloudflareError::resource_limit(ResourceLimitError {
            resource,
            limit: u64::try_from(limit).unwrap_or(u64::MAX),
            actual: u64::try_from(additional).ok(),
            kind: ResourceLimitKind::Allocation,
        })
    })
}

fn check_dns_pagination_bounds(
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<(), CloudflareError> {
    if let Some(page) = page {
        check_collection_limit(
            "DNS page number",
            usize::try_from(page).unwrap_or(usize::MAX),
            usize::try_from(MAX_DNS_PAGE).unwrap_or(usize::MAX),
        )?;
    }
    if let Some(per_page) = per_page {
        check_collection_limit(
            "DNS records per page",
            usize::try_from(per_page).unwrap_or(usize::MAX),
            usize::try_from(MAX_DNS_RECORDS_PER_PAGE).unwrap_or(usize::MAX),
        )?;
    }
    Ok(())
}

fn check_bulk_dns_bounds(record_count: usize) -> Result<(), CloudflareError> {
    check_collection_limit("bulk DNS records", record_count, MAX_BULK_DNS_RECORDS)
}

// ── Client ──────────────────────────────────────────────────────────────────

pub struct CloudflareClient {
    client: Client,
    api_key: String,
    email: Option<String>,
    max_retries: u32,
    api_base: String,
    request_timeout: Duration,
}

impl CloudflareClient {
    pub fn new(api_key: &str, email: Option<&str>) -> Self {
        Self {
            client: default_http_client(),
            api_key: api_key.to_string(),
            email: email.map(|s| s.to_string()),
            max_retries: MAX_RETRIES,
            api_base: CLOUDFLARE_API_BASE.to_string(),
            request_timeout: REQUEST_TIMEOUT,
        }
    }

    /// Create a client sharing an existing `reqwest::Client` for connection pooling.
    pub fn with_client(client: Client, api_key: &str, email: Option<&str>) -> Self {
        Self {
            client,
            api_key: api_key.to_string(),
            email: email.map(|s| s.to_string()),
            max_retries: MAX_RETRIES,
            api_base: CLOUDFLARE_API_BASE.to_string(),
            request_timeout: REQUEST_TIMEOUT,
        }
    }

    /// Set the maximum number of retries for retryable read transport failures,
    /// rate-limited responses, or server-error responses.
    pub fn with_max_retries(mut self, retries: u32) -> Self {
        self.max_retries = retries;
        self
    }

    #[cfg(test)]
    fn with_api_base(mut self, api_base: impl Into<String>) -> Self {
        self.api_base = api_base.into().trim_end_matches('/').to_string();
        self
    }

    #[cfg(test)]
    fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    fn apply_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let req = req.timeout(self.request_timeout);
        if let Some(email) = &self.email {
            req.header("X-Auth-Email", email)
                .header("X-Auth-Key", &self.api_key)
        } else {
            req.header("Authorization", format!("Bearer {}", self.api_key))
        }
    }

    // ── Retry with exponential backoff ──────────────────────────────────

    /// Execute a request-building closure with retry on 429 and 5xx responses.
    /// Uses capped exponential backoff, respecting bounded Retry-After headers.
    async fn request_with_retry<F>(
        &self,
        build_request: F,
    ) -> Result<reqwest::Response, CloudflareError>
    where
        F: Fn(&Self) -> reqwest::RequestBuilder,
    {
        let mut attempt = 0u32;
        loop {
            let request = build_request(self);
            let context = SafeRequestContext::from_builder(&request);
            let response = match request.send().await {
                Ok(response) => response,
                Err(error) => {
                    let transport = CloudflareTransportError::from_reqwest(
                        &error,
                        context.operation,
                        attempt + 1,
                        self.max_retries + 1,
                    );
                    if context.is_idempotent_read
                        && transport.retryable
                        && attempt < self.max_retries
                    {
                        attempt += 1;
                        tokio::time::sleep(retry_delay(attempt, None)).await;
                        continue;
                    }
                    return Err(CloudflareError::transport(
                        error,
                        context.operation,
                        attempt + 1,
                        self.max_retries + 1,
                    ));
                }
            };

            let status = response.status();

            // Retry rate limits for every method: a 429 is refused before the
            // request is processed, so re-sending it cannot duplicate a write.
            //
            // Retry server errors for idempotent reads only. Cloudflare's DNS
            // create endpoint has no idempotency key, so a 502 returned after
            // the record was committed is indistinguishable from one returned
            // before it. Re-sending the POST would create duplicate records.
            let retryable_status =
                status.as_u16() == 429 || (status.is_server_error() && context.is_idempotent_read);
            if status.is_success() || !retryable_status {
                return Ok(response);
            }

            // Retryable: 429 (rate limit) or 5xx (server error)
            attempt += 1;
            if attempt > self.max_retries {
                if context.operation == DNS_LIST_OPERATION {
                    return Err(dns_status_error(response).await);
                }
                if status.as_u16() == 429 {
                    return Err(CloudflareError::RateLimited(self.max_retries));
                }
                return Err(CloudflareError::ApiError(format!(
                    "Server error {} after {} retries",
                    status.as_u16(),
                    self.max_retries
                )));
            }

            // Calculate backoff: prefer Retry-After header, else exponential
            let retry_after_secs = parse_retry_after_secs(response.headers());
            tokio::time::sleep(retry_delay(attempt, retry_after_secs)).await;
        }
    }

    // ── Token verification ──────────────────────────────────────────────

    pub async fn verify_token(&self) -> Result<bool, CloudflareError> {
        let use_email = self.email.is_some();
        let endpoint = if use_email {
            "/user"
        } else {
            "/user/tokens/verify"
        };
        let url = format!("{}{}", self.api_base, endpoint);
        let mut attempt = 0u32;

        loop {
            let response = self
                .apply_auth(self.client.get(&url))
                .send()
                .await
                .map_err(|error| {
                    CloudflareError::Verification(Box::new(self.transport_error(&error)))
                })?;
            let status = response.status().as_u16();
            let retry_after_secs = parse_retry_after_secs(response.headers());
            let request_id = response
                .headers()
                .get("cf-ray")
                .and_then(|value| value.to_str().ok())
                .and_then(sanitize_request_id);
            let retryable_status = status == 408 || status == 429 || status >= 500;

            if retryable_status && attempt < self.max_retries {
                attempt += 1;
                tokio::time::sleep(retry_delay(attempt, retry_after_secs)).await;
                continue;
            }

            let body = read_bounded_response_body(response, MAX_RESPONSE_BODY_BYTES)
                .await
                .map_err(|error| match error {
                    ResponseBodyReadError::ResourceLimit(context) => {
                        CloudflareError::resource_limit(context)
                    }
                    ResponseBodyReadError::Stream(error) => {
                        CloudflareError::Verification(Box::new(self.transport_error(&error)))
                    }
                })?;
            let body = String::from_utf8_lossy(&body);
            return self.parse_verification_response(status, &body, retry_after_secs, request_id);
        }
    }

    fn parse_verification_response(
        &self,
        status: u16,
        body: &str,
        retry_after_secs: Option<u64>,
        request_id: Option<String>,
    ) -> Result<bool, CloudflareError> {
        let payload = serde_json::from_str::<Value>(body);
        if status < 400 {
            let payload = payload.map_err(|_| {
                CloudflareError::Verification(Box::new(CloudflareRequestError {
                    kind: VerificationFailureKind::MalformedResponse,
                    message: "Cloudflare returned an unreadable token verification response."
                        .to_string(),
                    status: Some(status),
                    source: VerificationErrorSource::Cloudflare,
                    operation: AUTH_OPERATION.to_string(),
                    retryable: true,
                    provider_errors: Vec::new(),
                    retry_after_secs,
                    remediation:
                        "Retry the request. If it continues, check Cloudflare service status."
                            .to_string(),
                    request_id: request_id.clone(),
                }))
            })?;
            match payload.get("success").and_then(Value::as_bool) {
                Some(true) => return Ok(true),
                Some(false) => {
                    return Err(CloudflareError::Verification(Box::new(
                        self.response_error(
                            VerificationFailureKind::Authentication,
                            status,
                            &payload,
                            retry_after_secs,
                            request_id,
                        ),
                    )));
                }
                None => {
                    return Err(CloudflareError::Verification(Box::new(
                        CloudflareRequestError {
                        kind: VerificationFailureKind::MalformedResponse,
                        message:
                            "Cloudflare token verification omitted the required success result."
                                .to_string(),
                        status: Some(status),
                        source: VerificationErrorSource::Cloudflare,
                        operation: AUTH_OPERATION.to_string(),
                        retryable: true,
                        provider_errors: Vec::new(),
                        retry_after_secs,
                        remediation:
                            "Retry the request. If it continues, check Cloudflare service status."
                                .to_string(),
                            request_id,
                        },
                    )));
                }
            }
        }

        let kind = match status {
            401 | 403 => VerificationFailureKind::Authentication,
            408 => VerificationFailureKind::Timeout,
            429 => VerificationFailureKind::RateLimited,
            500..=599 => VerificationFailureKind::Provider,
            _ => VerificationFailureKind::MalformedResponse,
        };
        let payload = payload.unwrap_or(Value::Null);
        Err(CloudflareError::Verification(Box::new(
            self.response_error(kind, status, &payload, retry_after_secs, request_id),
        )))
    }

    fn response_error(
        &self,
        kind: VerificationFailureKind,
        status: u16,
        payload: &Value,
        retry_after_secs: Option<u64>,
        request_id: Option<String>,
    ) -> CloudflareRequestError {
        let provider_errors = self.provider_errors(payload);
        let (message, retryable, remediation) = match (kind, status) {
            (VerificationFailureKind::Authentication, _) => (
                format!("Cloudflare rejected the supplied credentials (HTTP {status})."),
                false,
                "Check the API token or global API key, the account email when required, and the credential permissions.",
            ),
            (VerificationFailureKind::RateLimited, _) => (
                "Cloudflare rate-limited token verification.".to_string(),
                true,
                "Wait for the retry interval before trying again.",
            ),
            (VerificationFailureKind::Provider, _) => (
                format!("Cloudflare could not verify the credentials (HTTP {status})."),
                true,
                "Retry shortly and check Cloudflare service status if the failure continues.",
            ),
            (VerificationFailureKind::Timeout, 408) => (
                "Cloudflare timed out while processing token verification (HTTP 408).".to_string(),
                true,
                "Retry the request. If it continues, check the connection and Cloudflare service status.",
            ),
            (VerificationFailureKind::MalformedResponse, 400) => (
                "Cloudflare rejected token verification as an invalid request (HTTP 400)."
                    .to_string(),
                false,
                "Check that the selected credential type and account email match the supplied credential.",
            ),
            (VerificationFailureKind::MalformedResponse, 404 | 405) => (
                format!(
                    "Cloudflare did not accept the token verification endpoint or method (HTTP {status})."
                ),
                false,
                "Check for a Cloudflare API compatibility change and update the application before retrying.",
            ),
            (VerificationFailureKind::MalformedResponse, _) => (
                format!("Cloudflare rejected token verification (HTTP {status})."),
                false,
                "Check the request details and Cloudflare API compatibility before retrying.",
            ),
            _ => unreachable!("response errors are classified before construction"),
        };

        CloudflareRequestError {
            kind,
            message,
            status: Some(status),
            source: VerificationErrorSource::Cloudflare,
            operation: AUTH_OPERATION.to_string(),
            retryable,
            provider_errors,
            retry_after_secs,
            remediation: remediation.to_string(),
            request_id,
        }
    }

    fn provider_errors(&self, payload: &Value) -> Vec<CloudflareProviderError> {
        ["errors", "messages"]
            .into_iter()
            .filter_map(|field| payload.get(field).and_then(Value::as_array))
            .flatten()
            .filter_map(|item| {
                let code = item.get("code").and_then(|value| match value {
                    Value::Number(number) => Some(number.to_string()),
                    Value::String(string) => sanitize_provider_code(string),
                    _ => None,
                });
                let message = item
                    .get("message")
                    .and_then(Value::as_str)
                    .map(|message| self.sanitize_provider_message(message));
                if code.is_none() && message.is_none() {
                    return None;
                }
                Some(CloudflareProviderError {
                    code,
                    message: message.unwrap_or_else(|| "Cloudflare reported an error.".to_string()),
                })
            })
            .take(MAX_PROVIDER_ERRORS)
            .collect()
    }

    fn sanitize_provider_message(&self, message: &str) -> String {
        let mut sanitized = sanitize_error_text(message);
        for secret in std::iter::once(self.api_key.as_str()).chain(self.email.as_deref()) {
            if secret.is_empty() {
                continue;
            }
            sanitized = sanitized.replace(secret, "[redacted]");
        }
        sanitized
            .chars()
            .take(MAX_PROVIDER_MESSAGE_LENGTH)
            .collect()
    }

    fn transport_error(&self, error: &reqwest::Error) -> CloudflareRequestError {
        let (kind, message, remediation) = if error.is_timeout() {
            (
                VerificationFailureKind::Timeout,
                "Cloudflare token verification timed out.",
                "Check the connection, proxy, DNS, and TLS settings, then retry.",
            )
        } else {
            (
                VerificationFailureKind::Network,
                "Could not reach Cloudflare to verify the credentials.",
                "Check the internet connection, proxy, DNS, and TLS settings, then retry.",
            )
        };
        CloudflareRequestError {
            kind,
            message: message.to_string(),
            status: error.status().map(|status| status.as_u16()),
            source: VerificationErrorSource::Network,
            operation: AUTH_OPERATION.to_string(),
            retryable: true,
            provider_errors: Vec::new(),
            retry_after_secs: None,
            remediation: remediation.to_string(),
            request_id: None,
        }
    }

    // ── Zones ───────────────────────────────────────────────────────────

    pub async fn get_zones(&self) -> Result<Vec<Zone>, CloudflareError> {
        let response = self
            .request_with_retry(|s| {
                s.apply_auth(s.client.get("https://api.cloudflare.com/client/v4/zones"))
            })
            .await?;

        let json: Value = read_json_response(response).await?;

        let zones = json["result"]
            .as_array()
            .ok_or(CloudflareError::ApiError(
                "Invalid response format".to_string(),
            ))?
            .iter()
            .filter_map(|z| {
                let name_servers = z["name_servers"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Some(Zone {
                    id: z["id"].as_str()?.to_string(),
                    name: z["name"].as_str()?.to_string(),
                    name_servers,
                    status: z["status"].as_str().unwrap_or("unknown").to_string(),
                    paused: z["paused"].as_bool().unwrap_or(false),
                    r#type: z["type"].as_str().unwrap_or("").to_string(),
                    development_mode: z["development_mode"].as_u64().unwrap_or(0) as u32,
                })
            })
            .collect();

        Ok(zones)
    }

    // ── DNS Records ─────────────────────────────────────────────────────

    pub async fn get_dns_records(
        &self,
        zone_id: &str,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<Vec<DNSRecord>, CloudflareError> {
        check_dns_pagination_bounds(page, per_page).map_err(dns_validation_error)?;
        let mut url = format!(
            "{}/zones/{}/dns_records",
            self.api_base.trim_end_matches('/'),
            zone_id
        );
        let mut params = Vec::new();
        if let Some(page) = page {
            params.push(format!("page={}", page));
        }
        if let Some(per_page) = per_page {
            params.push(format!("per_page={}", per_page));
        }
        if !params.is_empty() {
            url.push('?');
            url.push_str(&params.join("&"));
        }

        let url_owned = url.clone();
        let response = self
            .request_with_retry(move |s| s.apply_auth(s.client.get(&url_owned)))
            .await?;

        if !response.status().is_success() {
            return Err(dns_status_error(response).await);
        }
        let (json, metadata) = read_dns_success_response(response).await?;

        validate_dns_records_envelope_success(&json)
            .map_err(|_| dns_malformed_response(&metadata))?;
        let source = json["result"]
            .as_array()
            .ok_or_else(|| dns_malformed_response(&metadata))?;
        check_collection_limit(
            "DNS records per page",
            source.len(),
            usize::try_from(MAX_DNS_RECORDS_PER_PAGE).unwrap_or(usize::MAX),
        )
        .map_err(|error| dns_response_error(error, &metadata))?;
        let mut records = Vec::new();
        try_reserve_exact(
            &mut records,
            source.len(),
            "parsed DNS records",
            usize::try_from(MAX_DNS_RECORDS_PER_PAGE).unwrap_or(usize::MAX),
        )
        .map_err(|error| dns_response_error(error, &metadata))?;
        extend_dns_records_fail_closed_for_zone(&mut records, source, zone_id)
            .map_err(|error| dns_record_parse_response(&metadata, &error))?;

        Ok(records)
    }

    pub async fn create_dns_record(
        &self,
        zone_id: &str,
        record: DNSRecordInput,
    ) -> Result<DNSRecord, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_records",
            zone_id
        );

        let response = self
            .request_with_retry(|s| s.apply_auth(s.client.post(&url).json(&record)))
            .await?;

        let (json, metadata) = read_dns_mutation_response(response).await?;
        let result = json
            .get("result")
            .ok_or_else(|| dns_malformed_response(&metadata))?;

        parse_dns_record_for_zone(result, zone_id)
            .map_err(|error| dns_record_mutation_parse_response(&metadata, error, "dns:create"))
    }

    pub async fn update_dns_record(
        &self,
        zone_id: &str,
        record_id: &str,
        record: DNSRecordInput,
    ) -> Result<DNSRecord, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_records/{}",
            zone_id, record_id
        );

        let response = self
            .request_with_retry(|s| s.apply_auth(s.client.put(&url).json(&record)))
            .await?;

        let (json, metadata) = read_dns_mutation_response(response).await?;
        let result = json
            .get("result")
            .ok_or_else(|| dns_malformed_response(&metadata))?;

        parse_dns_record_for_zone(result, zone_id)
            .map_err(|error| dns_record_mutation_parse_response(&metadata, error, "dns:update"))
    }

    pub async fn delete_dns_record(
        &self,
        zone_id: &str,
        record_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_records/{}",
            zone_id, record_id
        );

        let response = self
            .request_with_retry(|s| s.apply_auth(s.client.delete(&url)))
            .await?;
        let _ = read_dns_mutation_response(response).await?;
        Ok(())
    }

    pub async fn create_bulk_dns_records(
        &self,
        zone_id: &str,
        records: Vec<DNSRecordInput>,
        dryrun: bool,
    ) -> Result<Value, CloudflareError> {
        check_bulk_dns_bounds(records.len())?;
        if dryrun {
            let mut created = Vec::new();
            try_reserve_exact(
                &mut created,
                records.len(),
                "bulk DNS dry-run results",
                MAX_BULK_DNS_RECORDS,
            )?;
            created.extend(records.into_iter().map(|r| {
                json!({
                    "type": r.r#type,
                    "name": r.name,
                    "content": r.content,
                    "comment": r.comment,
                    "ttl": r.ttl,
                    "priority": r.priority,
                    "proxied": r.proxied
                })
            }));
            return Ok(json!({ "created": created, "skipped": [] }));
        }

        let mut created = Vec::new();
        let mut skipped = Vec::new();
        try_reserve_exact(
            &mut created,
            records.len(),
            "bulk DNS create results",
            MAX_BULK_DNS_RECORDS,
        )?;
        try_reserve_exact(
            &mut skipped,
            records.len(),
            "bulk DNS skipped results",
            MAX_BULK_DNS_RECORDS,
        )?;

        for (idx, record) in records.into_iter().enumerate() {
            match self.create_dns_record(zone_id, record).await {
                Ok(rec) => created.push(rec),
                Err(e) => skipped.push(json!({
                    "index": idx,
                    "error": e.to_string()
                })),
            }
        }

        Ok(json!({ "created": created, "skipped": skipped }))
    }

    pub async fn export_dns_records(
        &self,
        zone_id: &str,
        format: &str,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<String, CloudflareError> {
        let records = self.get_dns_records(zone_id, page, per_page).await?;

        match format {
            "json" => serde_json::to_string_pretty(&records)
                .map_err(|e| CloudflareError::ApiError(e.to_string())),
            "csv" => {
                let mut csv = "Type,Name,Content,TTL,Priority,Proxied\n".to_string();
                for record in records {
                    csv.push_str(&format!(
                        "{},{},{},{},{},{}\n",
                        record.r#type,
                        record.name,
                        record.content,
                        record.ttl.unwrap_or(1),
                        record.priority.unwrap_or(0),
                        record.proxied.unwrap_or(false)
                    ));
                }
                Ok(csv)
            }
            "bind" => {
                let mut bind = String::new();
                for record in records {
                    let ttl = record.ttl.unwrap_or(1);
                    let ttl = if ttl == 1 { 300 } else { ttl };
                    let priority = record
                        .priority
                        .map(|p| format!("{} ", p))
                        .unwrap_or_default();
                    bind.push_str(&format!(
                        "{}\t{}\tIN\t{}\t{}{}\n",
                        record.name, ttl, record.r#type, priority, record.content
                    ));
                }
                Ok(bind)
            }
            _ => Err(CloudflareError::ApiError("Unsupported format".to_string())),
        }
    }

    // ── Cache ───────────────────────────────────────────────────────────

    pub async fn purge_cache(
        &self,
        zone_id: &str,
        purge_everything: bool,
        files: Option<Vec<String>>,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/purge_cache",
            zone_id
        );
        let body = if purge_everything {
            json!({ "purge_everything": true })
        } else {
            json!({ "files": files.unwrap_or_default() })
        };

        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;

        let json: Value = read_json_response(response).await?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to purge cache");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    // ── Zone settings ───────────────────────────────────────────────────

    pub async fn get_zone_setting(
        &self,
        zone_id: &str,
        setting_id: &str,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/settings/{}",
            zone_id, setting_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;

        let json: Value = read_json_response(response).await?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to get zone setting");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    pub async fn update_zone_setting(
        &self,
        zone_id: &str,
        setting_id: &str,
        value: Value,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/settings/{}",
            zone_id, setting_id
        );
        let body = json!({ "value": value });
        let req = self.apply_auth(self.client.patch(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;

        let json: Value = read_json_response(response).await?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to update zone setting");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    // ── DNSSEC ──────────────────────────────────────────────────────────

    pub async fn get_dnssec(&self, zone_id: &str) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dnssec",
            zone_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;

        let json: Value = read_json_response(response).await?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to get DNSSEC");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    pub async fn update_dnssec(
        &self,
        zone_id: &str,
        payload: Value,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dnssec",
            zone_id
        );
        let req = self.apply_auth(self.client.patch(&url).json(&payload));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;

        let json: Value = read_json_response(response).await?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to update DNSSEC");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    // ── Analytics ───────────────────────────────────────────────────────

    fn safe_zone_analytics_text(&self, value: &str, limit: usize) -> String {
        let mut safe: String = value
            .chars()
            .map(|character| {
                if character.is_control() {
                    ' '
                } else {
                    character
                }
            })
            .take(limit)
            .collect();
        if !self.api_key.is_empty() {
            safe = safe.replace(&self.api_key, "[REDACTED]");
        }
        if let Some(email) = self.email.as_deref().filter(|email| !email.is_empty()) {
            safe = safe.replace(email, "[REDACTED]");
        }
        safe.trim().to_string()
    }

    fn zone_analytics_provider_errors(&self, response: &Value) -> Vec<CloudflareProviderError> {
        response
            .get("errors")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_PROVIDER_ERRORS)
            .map(|error| {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Cloudflare GraphQL analytics error");
                let code_value = error
                    .get("extensions")
                    .and_then(|extensions| extensions.get("code"))
                    .or_else(|| error.get("code"));
                let code = code_value
                    .and_then(|value| {
                        value
                            .as_str()
                            .map(str::to_string)
                            .or_else(|| value.as_i64().map(|number| number.to_string()))
                            .or_else(|| value.as_u64().map(|number| number.to_string()))
                    })
                    .map(|value| self.safe_zone_analytics_text(&value, 80));
                CloudflareProviderError {
                    code,
                    message: self.safe_zone_analytics_text(message, MAX_PROVIDER_MESSAGE_LENGTH),
                }
            })
            .collect()
    }

    fn zone_analytics_error(
        &self,
        message: &str,
        context: ZoneAnalyticsErrorContext,
        remediation: &str,
    ) -> CloudflareError {
        CloudflareError::Request(Box::new(CloudflareRequestError {
            kind: context.kind,
            message: self.safe_zone_analytics_text(message, MAX_PROVIDER_MESSAGE_LENGTH),
            status: context.status,
            source: VerificationErrorSource::Cloudflare,
            operation: ZONE_ANALYTICS_OPERATION.to_string(),
            retryable: context.retryable,
            provider_errors: context.provider_errors,
            retry_after_secs: context.retry_after_secs,
            remediation: remediation.to_string(),
            request_id: context.request_id,
        }))
    }

    /// Zone analytics dashboard (requests, bandwidth, threats, etc.).
    pub async fn get_zone_analytics(
        &self,
        zone_id: &str,
        since: &str,
        until: &str,
        _continuous: Option<bool>,
    ) -> Result<Value, CloudflareError> {
        let (start, end) = resolve_zone_analytics_bounds(since, until);
        let url = format!("{}/graphql", self.api_base.trim_end_matches('/'));
        let payload = json!({
            "query": ZONE_ANALYTICS_GRAPHQL_QUERY,
            "variables": {
                "zoneTag": zone_id,
                "start": &start,
                "end": &end,
            }
        });
        let response = self
            .request_with_retry(|state| state.apply_auth(state.client.post(&url).json(&payload)))
            .await?;
        let status = response.status().as_u16();
        let retry_after_secs = parse_retry_after_secs(response.headers());
        let request_id = response
            .headers()
            .get("cf-ray")
            .or_else(|| response.headers().get("x-request-id"))
            .and_then(|value| value.to_str().ok())
            .map(|value| self.safe_zone_analytics_text(value, 128));
        let response_value: Value = match read_json_response(response).await {
            Ok(value) => value,
            Err(error @ CloudflareError::ResourceLimit(_)) => return Err(error),
            Err(_) => {
                let (kind, retryable, remediation) = match status {
                    401 | 403 => (
                        VerificationFailureKind::Authentication,
                        false,
                        "Check the Cloudflare token or global-key permissions for zone analytics.",
                    ),
                    408 => (
                        VerificationFailureKind::Timeout,
                        true,
                        "Retry the analytics request after checking Cloudflare service health.",
                    ),
                    429 => (
                        VerificationFailureKind::RateLimited,
                        true,
                        "Wait for the Cloudflare rate-limit window before retrying.",
                    ),
                    500..=599 => (
                        VerificationFailureKind::Provider,
                        true,
                        "Retry after checking Cloudflare service health.",
                    ),
                    _ => (
                        VerificationFailureKind::MalformedResponse,
                        false,
                        "Retry once; if the response remains malformed, check Cloudflare GraphQL availability.",
                    ),
                };
                return Err(self.zone_analytics_error(
                    "Cloudflare returned a malformed GraphQL analytics response.",
                    ZoneAnalyticsErrorContext {
                        kind,
                        status: Some(status),
                        request_id,
                        retry_after_secs,
                        provider_errors: Vec::new(),
                        retryable,
                    },
                    remediation,
                ));
            }
        };

        let provider_errors = self.zone_analytics_provider_errors(&response_value);
        let has_graphql_errors = response_value.get("errors").is_some_and(|errors| {
            !errors.is_null() && errors.as_array().is_none_or(|items| !items.is_empty())
        });
        if !(200..300).contains(&status) || has_graphql_errors {
            let (kind, retryable, remediation) = match status {
                401 | 403 => (
                    VerificationFailureKind::Authentication,
                    false,
                    "Check the Cloudflare token or global-key permissions for zone analytics.",
                ),
                408 => (
                    VerificationFailureKind::Timeout,
                    true,
                    "Retry the analytics request after checking Cloudflare service health.",
                ),
                429 => (
                    VerificationFailureKind::RateLimited,
                    true,
                    "Wait for the Cloudflare rate-limit window before retrying.",
                ),
                500..=599 => (
                    VerificationFailureKind::Provider,
                    true,
                    "Retry after checking Cloudflare service health.",
                ),
                _ => (
                    VerificationFailureKind::Provider,
                    false,
                    "Check the zone ID and Cloudflare Analytics Read permissions.",
                ),
            };
            let message = provider_errors
                .first()
                .map(|error| error.message.clone())
                .unwrap_or_else(|| "Cloudflare GraphQL analytics request failed.".to_string());
            return Err(self.zone_analytics_error(
                &message,
                ZoneAnalyticsErrorContext {
                    kind,
                    status: Some(status),
                    request_id,
                    retry_after_secs,
                    provider_errors,
                    retryable,
                },
                remediation,
            ));
        }

        let envelope: ZoneAnalyticsGraphQlEnvelope =
            serde_json::from_value(response_value).map_err(|_| {
                self.zone_analytics_error(
                    "Cloudflare returned malformed GraphQL analytics fields.",
                    ZoneAnalyticsErrorContext {
                        kind: VerificationFailureKind::MalformedResponse,
                        status: Some(status),
                        request_id: request_id.clone(),
                        retry_after_secs,
                        provider_errors: Vec::new(),
                        retryable: false,
                    },
                    "Retry once; if the response remains malformed, check Cloudflare GraphQL availability.",
                )
            })?;
        let zone = envelope
            .data
            .map(|data| data.viewer.zones)
            .and_then(|zones| zones.into_iter().next())
            .ok_or_else(|| {
                self.zone_analytics_error(
                    "Cloudflare GraphQL returned no zone analytics data.",
                    ZoneAnalyticsErrorContext {
                        kind: VerificationFailureKind::MalformedResponse,
                        status: Some(status),
                        request_id: request_id.clone(),
                        retry_after_secs,
                        provider_errors: Vec::new(),
                        retryable: false,
                    },
                    "Check the zone ID and Cloudflare Analytics Read permissions.",
                )
            })?;

        let total_group = zone.totals.into_iter().next();
        let (total_sum, total_uniq) = total_group
            .map(|group| (group.sum, group.uniq))
            .unwrap_or_default();
        let totals = json!({
            "requests": total_sum.requests,
            "bandwidth": total_sum.bytes,
            "threats": total_sum.threats,
            "pageviews": total_sum.page_views,
            "uniques": total_uniq.uniques,
        });

        let mut starts = Vec::with_capacity(zone.timeseries.len());
        for group in &zone.timeseries {
            let start = group
                .dimensions
                .as_ref()
                .map(|dimensions| dimensions.datetime_five_minutes.trim())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    self.zone_analytics_error(
                        "Cloudflare returned an analytics bucket without a timestamp.",
                        ZoneAnalyticsErrorContext {
                            kind: VerificationFailureKind::MalformedResponse,
                            status: Some(status),
                            request_id: request_id.clone(),
                            retry_after_secs,
                            provider_errors: Vec::new(),
                            retryable: false,
                        },
                        "Retry once; if the response remains malformed, check Cloudflare GraphQL availability.",
                    )
                })?;
            starts.push(start.to_string());
        }
        let timeseries: Vec<Value> = zone
            .timeseries
            .into_iter()
            .enumerate()
            .map(|(index, group)| {
                json!({
                    "since": starts[index],
                    "until": starts.get(index + 1).unwrap_or(&end),
                    "requests": group.sum.requests,
                    "bandwidth": group.sum.bytes,
                    "threats": group.sum.threats,
                    "pageviews": group.sum.page_views,
                    "uniques": group.uniq.uniques,
                })
            })
            .collect();

        Ok(json!({ "totals": totals, "timeseries": timeseries }))
    }

    /// DNS analytics report.
    pub async fn get_dns_analytics(
        &self,
        zone_id: &str,
        since: &str,
        until: &str,
        dimensions: Option<Vec<String>>,
        metrics: Option<Vec<String>>,
    ) -> Result<Value, CloudflareError> {
        let mut url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_analytics/report?since={}&until={}",
            zone_id, since, until
        );
        if let Some(dims) = dimensions {
            url.push_str(&format!("&dimensions={}", dims.join(",")));
        }
        if let Some(mets) = metrics {
            url.push_str(&format!("&metrics={}", mets.join(",")));
        }
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("DNS analytics error");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    // ── Firewall / WAF ─────────────────────────────────────────────────

    pub async fn get_firewall_rules(
        &self,
        zone_id: &str,
    ) -> Result<Vec<FirewallRule>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/rules",
            zone_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let rules: Vec<FirewallRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    pub async fn create_firewall_rule(
        &self,
        zone_id: &str,
        rule: FirewallRuleInput,
    ) -> Result<FirewallRule, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/rules",
            zone_id
        );
        let body = json!([{
            "paused": rule.paused, "description": rule.description, "action": rule.action,
            "priority": rule.priority,
            "filter": { "expression": rule.filter.expression, "paused": rule.filter.paused, "description": rule.filter.description }
        }]);
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let rules: Vec<FirewallRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        rules
            .into_iter()
            .next()
            .ok_or_else(|| CloudflareError::ApiError("No rule returned".to_string()))
    }

    pub async fn update_firewall_rule(
        &self,
        zone_id: &str,
        rule_id: &str,
        rule: FirewallRuleInput,
    ) -> Result<FirewallRule, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/rules/{}",
            zone_id, rule_id
        );
        let body = json!({
            "paused": rule.paused, "description": rule.description, "action": rule.action,
            "priority": rule.priority,
            "filter": { "expression": rule.filter.expression, "paused": rule.filter.paused, "description": rule.filter.description }
        });
        let req = self.apply_auth(self.client.put(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let rule: FirewallRule = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rule)
    }

    pub async fn delete_firewall_rule(
        &self,
        zone_id: &str,
        rule_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/rules/{}",
            zone_id, rule_id
        );
        let req = self.apply_auth(self.client.delete(&url));
        req.send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        Ok(())
    }

    pub async fn get_ip_access_rules(
        &self,
        zone_id: &str,
    ) -> Result<Vec<IpAccessRule>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/access_rules/rules",
            zone_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let rules: Vec<IpAccessRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    pub async fn create_ip_access_rule(
        &self,
        zone_id: &str,
        mode: &str,
        value: &str,
        notes: &str,
    ) -> Result<IpAccessRule, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/access_rules/rules",
            zone_id
        );
        let body = json!({ "mode": mode, "configuration": { "target": "ip", "value": value }, "notes": notes });
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let rule: IpAccessRule = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rule)
    }

    pub async fn delete_ip_access_rule(
        &self,
        zone_id: &str,
        rule_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/access_rules/rules/{}",
            zone_id, rule_id
        );
        let req = self.apply_auth(self.client.delete(&url));
        req.send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        Ok(())
    }

    pub async fn get_waf_rulesets(
        &self,
        zone_id: &str,
    ) -> Result<Vec<WafRuleset>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/rulesets",
            zone_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let rulesets: Vec<WafRuleset> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rulesets)
    }

    // ── Workers ─────────────────────────────────────────────────────────

    pub async fn get_worker_routes(
        &self,
        zone_id: &str,
    ) -> Result<Vec<WorkerRoute>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/workers/routes",
            zone_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let routes: Vec<WorkerRoute> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(routes)
    }

    pub async fn create_worker_route(
        &self,
        zone_id: &str,
        pattern: &str,
        script: &str,
    ) -> Result<WorkerRoute, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/workers/routes",
            zone_id
        );
        let body = json!({ "pattern": pattern, "script": script });
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let route: WorkerRoute = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(route)
    }

    pub async fn delete_worker_route(
        &self,
        zone_id: &str,
        route_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/workers/routes/{}",
            zone_id, route_id
        );
        let req = self.apply_auth(self.client.delete(&url));
        req.send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        Ok(())
    }

    // ── Email Routing ───────────────────────────────────────────────────

    pub async fn get_email_routing_settings(
        &self,
        zone_id: &str,
    ) -> Result<EmailRoutingSettings, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/email/routing",
            zone_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let settings: EmailRoutingSettings = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(settings)
    }

    pub async fn get_email_routing_rules(
        &self,
        zone_id: &str,
    ) -> Result<Vec<EmailRoutingRule>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/email/routing/rules",
            zone_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let rules: Vec<EmailRoutingRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    pub async fn create_email_routing_rule(
        &self,
        zone_id: &str,
        rule: &EmailRoutingRule,
    ) -> Result<EmailRoutingRule, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/email/routing/rules",
            zone_id
        );
        let body = serde_json::to_value(rule)
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let created: EmailRoutingRule = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(created)
    }

    pub async fn delete_email_routing_rule(
        &self,
        zone_id: &str,
        rule_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/email/routing/rules/{}",
            zone_id, rule_id
        );
        let req = self.apply_auth(self.client.delete(&url));
        req.send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        Ok(())
    }

    // ── Page Rules ──────────────────────────────────────────────────────

    pub async fn get_page_rules(&self, zone_id: &str) -> Result<Vec<PageRule>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/pagerules",
            zone_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string().into()))?;
        let json: Value = read_json_response(response).await?;
        let rules: Vec<PageRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    // ── Bulk deletion ───────────────────────────────────────────────────

    pub async fn delete_bulk_dns_records(
        &self,
        zone_id: &str,
        record_ids: &[String],
    ) -> Result<Value, CloudflareError> {
        check_bulk_dns_bounds(record_ids.len())?;
        let mut deleted = Vec::new();
        let mut failed = Vec::new();
        try_reserve_exact(
            &mut deleted,
            record_ids.len(),
            "bulk DNS delete results",
            MAX_BULK_DNS_RECORDS,
        )?;
        try_reserve_exact(
            &mut failed,
            record_ids.len(),
            "bulk DNS failed results",
            MAX_BULK_DNS_RECORDS,
        )?;
        for id in record_ids {
            match self.delete_dns_record(zone_id, id).await {
                Ok(()) => deleted.push(id.clone()),
                Err(e) => failed.push(json!({ "id": id, "error": e.to_string() })),
            }
        }
        Ok(json!({ "deleted": deleted, "failed": failed }))
    }
}

fn parse_retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.min(MAX_RETRY_DELAY.as_secs()))
}

fn retry_delay(attempt: u32, retry_after_secs: Option<u64>) -> Duration {
    let maximum_ms = MAX_RETRY_DELAY.as_millis() as u64;
    let delay_ms = retry_after_secs
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or_else(|| {
            2u64.checked_pow(attempt.saturating_sub(1))
                .and_then(|multiplier| INITIAL_BACKOFF_MS.checked_mul(multiplier))
                .unwrap_or(u64::MAX)
        })
        .min(maximum_ms);
    Duration::from_millis(delay_ms)
}

fn sanitize_provider_code(code: &str) -> Option<String> {
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

fn sanitize_request_id(request_id: &str) -> Option<String> {
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

fn sanitize_error_text(value: &str) -> String {
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
    sanitized.join(" ")
}

// ── Parsing helper ──────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
struct CloudflareDnsRecordWire {
    #[serde(default)]
    id: Option<String>,
    #[serde(rename = "type")]
    record_type: String,
    name: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    comment: Option<String>,
    #[serde(default)]
    ttl: Option<u32>,
    #[serde(default)]
    priority: Option<u16>,
    #[serde(default)]
    proxied: Option<bool>,
    #[serde(default, rename = "zone_id")]
    _provider_zone_id: Option<String>,
    #[serde(default)]
    zone_name: Option<String>,
    created_on: String,
    modified_on: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DNSRecordParseFailure {
    InvalidShape,
    InvalidIdentity,
    InvalidScalar,
    MissingContent,
    InvalidStructuredData,
    UnsupportedStructuredType,
}

impl DNSRecordParseFailure {
    fn category(self) -> &'static str {
        match self {
            Self::InvalidShape => "invalid_shape",
            Self::InvalidIdentity => "invalid_identity",
            Self::InvalidScalar => "invalid_scalar",
            Self::MissingContent => "missing_content",
            Self::InvalidStructuredData => "invalid_structured_data",
            Self::UnsupportedStructuredType => "unsupported_structured_type",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct DNSRecordParseError {
    record_type: &'static str,
    failure: DNSRecordParseFailure,
}

#[derive(Debug, PartialEq, Eq)]
struct DNSRecordPageParseError {
    index: usize,
    error: DNSRecordParseError,
}

impl std::fmt::Display for DNSRecordPageParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Invalid DNS record response at result index {} (type {}, category {})",
            self.index,
            self.error.record_type,
            self.error.failure.category()
        )
    }
}

fn redacted_dns_record_type(value: &Value) -> &'static str {
    match value.get("type").and_then(Value::as_str) {
        Some("A") => "A",
        Some("AAAA") => "AAAA",
        Some("CAA") => "CAA",
        Some("CERT") => "CERT",
        Some("CNAME") => "CNAME",
        Some("DNSKEY") => "DNSKEY",
        Some("DS") => "DS",
        Some("HTTPS") => "HTTPS",
        Some("LOC") => "LOC",
        Some("MX") => "MX",
        Some("NAPTR") => "NAPTR",
        Some("NS") => "NS",
        Some("OPENPGPKEY") => "OPENPGPKEY",
        Some("PTR") => "PTR",
        Some("SMIMEA") => "SMIMEA",
        Some("SRV") => "SRV",
        Some("SSHFP") => "SSHFP",
        Some("SVCB") => "SVCB",
        Some("TLSA") => "TLSA",
        Some("TXT") => "TXT",
        Some("URI") => "URI",
        _ => "OTHER",
    }
}

fn structured_string<'a>(
    data: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, DNSRecordParseFailure> {
    data.get(key)
        .and_then(Value::as_str)
        .ok_or(DNSRecordParseFailure::InvalidStructuredData)
}

fn optional_structured_string<'a>(
    data: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, DNSRecordParseFailure> {
    match data.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        _ => Err(DNSRecordParseFailure::InvalidStructuredData),
    }
}

fn structured_integer(
    data: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<u64, DNSRecordParseFailure> {
    data.get(key)
        .and_then(Value::as_u64)
        .ok_or(DNSRecordParseFailure::InvalidStructuredData)
}

fn structured_number_text(
    data: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, DNSRecordParseFailure> {
    match data.get(key) {
        Some(Value::Number(value)) => Ok(value.to_string()),
        _ => Err(DNSRecordParseFailure::InvalidStructuredData),
    }
}

fn quote_dns_character_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('\"', "\\\""))
}

fn format_structured_dns_content(
    record_type: &str,
    data: Option<&Value>,
    top_level_priority: Option<u16>,
) -> Result<String, DNSRecordParseFailure> {
    let data = data.ok_or(DNSRecordParseFailure::MissingContent)?;
    let object = data
        .as_object()
        .ok_or(DNSRecordParseFailure::InvalidStructuredData)?;

    match record_type {
        "CAA" => Ok(format!(
            "{} {} {}",
            structured_integer(object, "flags")?,
            structured_string(object, "tag")?,
            quote_dns_character_string(structured_string(object, "value")?)
        )),
        "CERT" => Ok(format!(
            "{} {} {} {}",
            structured_integer(object, "type")?,
            structured_integer(object, "key_tag")?,
            structured_integer(object, "algorithm")?,
            structured_string(object, "certificate")?
        )),
        "DNSKEY" => Ok(format!(
            "{} {} {} {}",
            structured_integer(object, "flags")?,
            structured_integer(object, "protocol")?,
            structured_integer(object, "algorithm")?,
            structured_string(object, "public_key")?
        )),
        "DS" => Ok(format!(
            "{} {} {} {}",
            structured_integer(object, "key_tag")?,
            structured_integer(object, "algorithm")?,
            structured_integer(object, "digest_type")?,
            structured_string(object, "digest")?
        )),
        "HTTPS" | "SVCB" => {
            let priority = structured_integer(object, "priority")?;
            let target = structured_string(object, "target")?;
            match optional_structured_string(object, "value")? {
                Some(value) if !value.is_empty() => Ok(format!("{priority} {target} {value}")),
                _ => Ok(format!("{priority} {target}")),
            }
        }
        "LOC" => {
            let latitude_direction = structured_string(object, "lat_direction")?;
            if !matches!(latitude_direction, "N" | "S") {
                return Err(DNSRecordParseFailure::InvalidStructuredData);
            }
            let longitude_direction = structured_string(object, "long_direction")?;
            if !matches!(longitude_direction, "E" | "W") {
                return Err(DNSRecordParseFailure::InvalidStructuredData);
            }
            Ok(format!(
                "{} {} {} {} {} {} {} {} {}m {}m {}m {}m",
                structured_number_text(object, "lat_degrees")?,
                structured_number_text(object, "lat_minutes")?,
                structured_number_text(object, "lat_seconds")?,
                latitude_direction,
                structured_number_text(object, "long_degrees")?,
                structured_number_text(object, "long_minutes")?,
                structured_number_text(object, "long_seconds")?,
                longitude_direction,
                structured_number_text(object, "altitude")?,
                structured_number_text(object, "size")?,
                structured_number_text(object, "precision_horz")?,
                structured_number_text(object, "precision_vert")?
            ))
        }
        "NAPTR" => Ok(format!(
            "{} {} {} {} {} {}",
            structured_integer(object, "order")?,
            structured_integer(object, "preference")?,
            quote_dns_character_string(structured_string(object, "flags")?),
            quote_dns_character_string(structured_string(object, "service")?),
            quote_dns_character_string(structured_string(object, "regex")?),
            structured_string(object, "replacement")?
        )),
        "SMIMEA" | "TLSA" => Ok(format!(
            "{} {} {} {}",
            structured_integer(object, "usage")?,
            structured_integer(object, "selector")?,
            structured_integer(object, "matching_type")?,
            structured_string(object, "certificate")?
        )),
        "SRV" => Ok(format!(
            "{} {} {} {}",
            structured_integer(object, "priority")?,
            structured_integer(object, "weight")?,
            structured_integer(object, "port")?,
            structured_string(object, "target")?
        )),
        "SSHFP" => Ok(format!(
            "{} {} {}",
            structured_integer(object, "algorithm")?,
            structured_integer(object, "type")?,
            structured_string(object, "fingerprint")?
        )),
        "URI" => {
            let priority = match object.get("priority") {
                None | Some(Value::Null) => top_level_priority
                    .map(u64::from)
                    .ok_or(DNSRecordParseFailure::InvalidStructuredData)?,
                Some(value) => value
                    .as_u64()
                    .ok_or(DNSRecordParseFailure::InvalidStructuredData)?,
            };
            Ok(format!(
                "{} {} {}",
                priority,
                structured_integer(object, "weight")?,
                quote_dns_character_string(structured_string(object, "target")?)
            ))
        }
        _ => Err(DNSRecordParseFailure::UnsupportedStructuredType),
    }
}

fn parse_dns_record_for_zone(
    value: &Value,
    requested_zone_id: &str,
) -> Result<DNSRecord, DNSRecordParseError> {
    let record_type = redacted_dns_record_type(value);
    let object = value.as_object().ok_or(DNSRecordParseError {
        record_type,
        failure: DNSRecordParseFailure::InvalidShape,
    })?;
    if !matches!(object.get("type"), Some(Value::String(value)) if !value.trim().is_empty())
        || !matches!(object.get("name"), Some(Value::String(value)) if !value.trim().is_empty())
    {
        return Err(DNSRecordParseError {
            record_type,
            failure: DNSRecordParseFailure::InvalidIdentity,
        });
    }

    let wire: CloudflareDnsRecordWire =
        serde_json::from_value(value.clone()).map_err(|_| DNSRecordParseError {
            record_type,
            failure: DNSRecordParseFailure::InvalidScalar,
        })?;
    let content = match wire.content.as_ref() {
        Some(content) => content.clone(),
        None => format_structured_dns_content(&wire.record_type, wire.data.as_ref(), wire.priority)
            .map_err(|failure| DNSRecordParseError {
                record_type,
                failure,
            })?,
    };

    Ok(DNSRecord {
        id: wire.id,
        r#type: wire.record_type,
        name: wire.name,
        content,
        comment: wire.comment,
        ttl: wire.ttl,
        priority: wire.priority,
        proxied: wire.proxied,
        zone_id: requested_zone_id.to_string(),
        zone_name: wire.zone_name.unwrap_or_default(),
        created_on: wire.created_on,
        modified_on: wire.modified_on,
    })
}

fn extend_dns_records_fail_closed_for_zone(
    output: &mut Vec<DNSRecord>,
    source: &[Value],
    requested_zone_id: &str,
) -> Result<(), DNSRecordPageParseError> {
    let mut parsed = Vec::with_capacity(source.len());
    for (index, value) in source.iter().enumerate() {
        let record = parse_dns_record_for_zone(value, requested_zone_id)
            .map_err(|error| DNSRecordPageParseError { index, error })?;
        parsed.push(record);
    }
    output.extend(parsed);
    Ok(())
}

fn dns_record_parse_response(
    metadata: &DnsResponseMetadata,
    error: &DNSRecordPageParseError,
) -> CloudflareError {
    dns_record_parse_response_for_operation(metadata, error, DNS_LIST_OPERATION)
}

fn dns_record_mutation_parse_response(
    metadata: &DnsResponseMetadata,
    error: DNSRecordParseError,
    operation: &str,
) -> CloudflareError {
    dns_record_parse_response_for_operation(
        metadata,
        &DNSRecordPageParseError { index: 0, error },
        operation,
    )
}

fn dns_record_parse_response_for_operation(
    metadata: &DnsResponseMetadata,
    error: &DNSRecordPageParseError,
    operation: &str,
) -> CloudflareError {
    dns_request_error(CloudflareRequestError {
        kind: VerificationFailureKind::MalformedResponse,
        message: "Cloudflare returned a malformed DNS records response.".to_string(),
        status: Some(metadata.status),
        source: VerificationErrorSource::Cloudflare,
        operation: operation.to_string(),
        retryable: false,
        provider_errors: vec![CloudflareProviderError {
            code: Some("record_parse".to_string()),
            message: format!(
                "result_index={}; record_type={}; failure_category={}",
                error.index,
                error.error.record_type,
                error.error.failure.category()
            ),
        }],
        retry_after_secs: None,
        remediation:
            "Retry the request and update the application if Cloudflare continues returning this record shape."
                .to_string(),
        request_id: metadata.request_id.clone(),
    })
}

fn validate_dns_records_envelope_success(value: &Value) -> Result<(), CloudflareError> {
    if value.get("success").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(CloudflareError::ApiError(
            "Invalid DNS record response envelope".to_string(),
        ))
    }
}

#[cfg(test)]
fn extend_dns_records_fail_closed(
    output: &mut Vec<DNSRecord>,
    source: &[Value],
) -> Result<(), CloudflareError> {
    let requested_zone_id = source
        .first()
        .and_then(|value| value.get("zone_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    extend_dns_records_fail_closed_for_zone(output, source, requested_zone_id)
        .map_err(|error| CloudflareError::ApiError(error.to_string()))
}

#[cfg(test)]
mod dns_record_wire_regression_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn provider_record(record_type: &str, data: Value) -> Value {
        json!({
            "id": format!("record-{record_type}"),
            "type": record_type,
            "name": "structured.example.com",
            "data": data,
            "comment": null,
            "ttl": 1,
            "proxied": false,
            "proxiable": false,
            "settings": {},
            "meta": {"auto_added": false},
            "tags": [],
            "created_on": "2026-07-28T00:00:00Z",
            "modified_on": "2026-07-28T00:00:01Z"
        })
    }

    fn spawn_json_response(body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind DNS fixture server");
        let address = listener.local_addr().expect("read DNS fixture address");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept DNS fixture request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write DNS fixture response");
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn cloudflare_list_response_normalizes_all_structured_record_variants() {
        let fixtures = vec![
            (
                "CAA",
                json!({"flags": 0, "tag": "issue", "value": "letsencrypt.org", "future": true}),
                "0 issue \"letsencrypt.org\"",
            ),
            (
                "CERT",
                json!({"type": 1, "key_tag": 2, "algorithm": 8, "certificate": "CERTDATA"}),
                "1 2 8 CERTDATA",
            ),
            (
                "DNSKEY",
                json!({"flags": 257, "protocol": 3, "algorithm": 8, "public_key": "AwEA"}),
                "257 3 8 AwEA",
            ),
            (
                "DS",
                json!({"key_tag": 12345, "algorithm": 8, "digest_type": 2, "digest": "aabb"}),
                "12345 8 2 aabb",
            ),
            (
                "HTTPS",
                json!({"priority": 1, "target": ".", "value": "alpn=h3,h2 ipv4hint=192.0.2.1"}),
                "1 . alpn=h3,h2 ipv4hint=192.0.2.1",
            ),
            (
                "LOC",
                json!({"lat_degrees": 51, "lat_minutes": 30, "lat_seconds": 12.5, "lat_direction": "N", "long_degrees": 0, "long_minutes": 7, "long_seconds": 1.25, "long_direction": "W", "altitude": 15.5, "size": 1, "precision_horz": 10, "precision_vert": 2}),
                "51 30 12.5 N 0 7 1.25 W 15.5m 1m 10m 2m",
            ),
            (
                "NAPTR",
                json!({"order": 100, "preference": 10, "flags": "s", "service": "SIP+D2U", "regex": "", "replacement": "_sip._udp.example.com."}),
                "100 10 \"s\" \"SIP+D2U\" \"\" _sip._udp.example.com.",
            ),
            (
                "SMIMEA",
                json!({"usage": 3, "selector": 1, "matching_type": 1, "certificate": "aabb"}),
                "3 1 1 aabb",
            ),
            (
                "SRV",
                json!({"priority": 10, "weight": 20, "port": 443, "target": "service.example.com."}),
                "10 20 443 service.example.com.",
            ),
            (
                "SSHFP",
                json!({"algorithm": 1, "type": 2, "fingerprint": "aabb"}),
                "1 2 aabb",
            ),
            (
                "SVCB",
                json!({"priority": 1, "target": "target.example.com.", "value": "alpn=h2"}),
                "1 target.example.com. alpn=h2",
            ),
            (
                "TLSA",
                json!({"usage": 3, "selector": 1, "matching_type": 1, "certificate": "ccdd"}),
                "3 1 1 ccdd",
            ),
            (
                "URI",
                json!({"priority": 10, "weight": 20, "target": "https://example.com/a\\\"b"}),
                r#"10 20 "https://example.com/a\\\"b""#,
            ),
        ];
        let expected = fixtures
            .iter()
            .map(|(_, _, content)| (*content).to_string())
            .collect::<Vec<_>>();
        let result = fixtures
            .into_iter()
            .map(|(record_type, data, _)| provider_record(record_type, data))
            .collect::<Vec<_>>();
        let body = json!({
            "success": true,
            "errors": [],
            "messages": [],
            "result": result,
            "result_info": {"page": 1, "per_page": 100, "count": 13, "total_count": 13}
        })
        .to_string();
        let client = CloudflareClient::new("fixture-token", None)
            .with_api_base(spawn_json_response(body))
            .with_max_retries(0);

        let records = client
            .get_dns_records("requested-zone-id", Some(1), Some(100))
            .await
            .expect("current Cloudflare record union must parse");

        assert_eq!(records.len(), 13);
        assert_eq!(
            records
                .iter()
                .map(|record| record.content.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert!(records
            .iter()
            .all(|record| record.zone_id == "requested-zone-id" && record.zone_name.is_empty()));
    }

    #[test]
    fn string_content_wins_but_unknown_data_only_records_fail_safely() {
        let with_content = json!({
            "id": "record-id",
            "type": "FUTURE",
            "name": "future.example.com",
            "content": "opaque provider content",
            "data": {"unrecognized": [true]},
            "created_on": "2026-07-28T00:00:00Z",
            "modified_on": "2026-07-28T00:00:01Z"
        });
        assert_eq!(
            parse_dns_record_for_zone(&with_content, "requested-zone")
                .expect("provider content remains authoritative")
                .content,
            "opaque provider content"
        );

        let data_only = json!({
            "id": "secret-record-id",
            "type": "FUTURE-secret-type",
            "name": "secret-name.example.com",
            "data": {"secret": "secret-content"},
            "created_on": "2026-07-28T00:00:00Z",
            "modified_on": "2026-07-28T00:00:01Z"
        });
        let mut output = vec![parse_dns_record_for_zone(
            &json!({
                "id": "existing",
                "type": "A",
                "name": "existing.example.com",
                "content": "192.0.2.1",
                "created_on": "2026-07-28T00:00:00Z",
                "modified_on": "2026-07-28T00:00:01Z"
            }),
            "existing-zone",
        )
        .expect("existing fixture parses")];
        let error =
            extend_dns_records_fail_closed_for_zone(&mut output, &[data_only], "secret-zone-id")
                .expect_err("unknown data-only type must fail closed");
        assert_eq!(output.len(), 1, "page parsing must be transactional");
        assert_eq!(error.index, 0);
        assert_eq!(error.error.record_type, "OTHER");
        assert_eq!(
            error.error.failure,
            DNSRecordParseFailure::UnsupportedStructuredType
        );

        let rendered = format!(
            "{:?}",
            dns_record_parse_response(
                &DnsResponseMetadata {
                    status: 200,
                    request_id: Some("safe-ray-id".to_string()),
                },
                &error,
            )
        );
        for forbidden in [
            "secret-record-id",
            "secret-type",
            "secret-name",
            "secret-content",
            "secret-zone-id",
        ] {
            assert!(!rendered.contains(forbidden));
        }
        assert!(rendered.contains("result_index=0"));
        assert!(rendered.contains("record_type=OTHER"));
        assert!(rendered.contains("failure_category=unsupported_structured_type"));
    }

    #[test]
    fn list_envelope_identities_scalars_and_structured_fields_fail_closed() {
        assert!(validate_dns_records_envelope_success(&json!({"success": true})).is_ok());
        for envelope in [
            json!({"success": false, "result": []}),
            json!({"result": []}),
            json!({"success": "true", "result": []}),
        ] {
            assert!(validate_dns_records_envelope_success(&envelope).is_err());
        }

        let invalid_identity = json!({
            "type": 1,
            "name": "example.com",
            "content": "192.0.2.1",
            "created_on": "2026-07-28T00:00:00Z",
            "modified_on": "2026-07-28T00:00:01Z"
        });
        assert_eq!(
            parse_dns_record_for_zone(&invalid_identity, "zone")
                .expect_err("non-string type must fail")
                .failure,
            DNSRecordParseFailure::InvalidIdentity
        );

        let invalid_scalar = json!({
            "type": "A",
            "name": "example.com",
            "content": 123,
            "created_on": "2026-07-28T00:00:00Z",
            "modified_on": "2026-07-28T00:00:01Z"
        });
        assert_eq!(
            parse_dns_record_for_zone(&invalid_scalar, "zone")
                .expect_err("non-string content must fail")
                .failure,
            DNSRecordParseFailure::InvalidScalar
        );

        let invalid_structured = provider_record(
            "HTTPS",
            json!({"priority": 1.5, "target": "target.example.com."}),
        );
        assert_eq!(
            parse_dns_record_for_zone(&invalid_structured, "zone")
                .expect_err("fractional structured integer must fail")
                .failure,
            DNSRecordParseFailure::InvalidStructuredData
        );
    }
}

#[cfg(test)]
mod auth_verification_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn valid_dns_record_value(id: &str) -> Value {
        json!({
            "id": id,
            "type": "A",
            "name": "www.example.com",
            "content": "192.0.2.1",
            "comment": null,
            "ttl": 300,
            "priority": null,
            "proxied": false,
            "zone_id": "zone-1",
            "zone_name": "example.com",
            "created_on": "2026-01-01T00:00:00Z",
            "modified_on": "2026-01-01T00:00:00Z"
        })
    }

    #[test]
    fn dns_record_pages_fail_closed_on_any_malformed_provider_record() {
        let source = vec![
            valid_dns_record_value("valid"),
            json!({
                "id": "malformed",
                "type": "A",
                "name": "broken.example.com",
                "content": 123,
                "zone_id": "zone-1",
                "zone_name": "example.com",
                "created_on": "2026-01-01T00:00:00Z",
                "modified_on": "2026-01-01T00:00:00Z"
            }),
        ];
        let mut output = Vec::new();
        let error = extend_dns_records_fail_closed(&mut output, &source).unwrap_err();
        assert!(error.to_string().contains("result index 1"));
    }

    fn spawn_response(
        status: u16,
        extra_headers: &[(&str, &str)],
        body: &str,
        delay: Duration,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let reason = match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            408 => "Request Timeout",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            _ => "Test Response",
        };
        let body = body.as_bytes().to_vec();
        let headers = extra_headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}\r\n"))
            .collect::<String>();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept test request");
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
                body.len(),
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(&body);
        });
        format!("http://{address}")
    }

    fn spawn_raw_response(response_headers: &str, chunks: Vec<(Duration, Vec<u8>)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let response_headers = response_headers.as_bytes().to_vec();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept test request");
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(&response_headers);
            for (delay, chunk) in chunks {
                if !delay.is_zero() {
                    thread::sleep(delay);
                }
                if stream.write_all(&chunk).is_err() {
                    break;
                }
            }
        });
        format!("http://{address}")
    }

    async fn fetch_response(base: &str, timeout: Duration) -> Response {
        Client::new()
            .get(base)
            .timeout(timeout)
            .send()
            .await
            .expect("fetch test response headers")
    }

    fn test_client(base: String, api_key: &str) -> CloudflareClient {
        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .expect("test reqwest client");
        CloudflareClient::with_client(client, api_key, None)
            .with_max_retries(0)
            .with_api_base(base)
    }

    fn request_context(error: &CloudflareError) -> &CloudflareRequestError {
        match error {
            CloudflareError::Verification(context) => context,
            other => panic!("expected structured verification error, got {other:?}"),
        }
    }

    fn resource_context(error: &CloudflareError) -> &ResourceLimitError {
        match error {
            CloudflareError::HttpError(CloudflareHttpError::ResourceLimit(context)) => context,
            other => panic!("expected structured resource limit error, got {other:?}"),
        }
    }

    #[test]
    fn production_clients_have_an_explicit_request_timeout() {
        assert!(!REQUEST_TIMEOUT.is_zero());
        assert_eq!(
            CloudflareClient::new("token", None).request_timeout,
            REQUEST_TIMEOUT
        );
        assert_eq!(
            CloudflareClient::with_client(Client::new(), "token", None).request_timeout,
            REQUEST_TIMEOUT
        );
    }

    #[test]
    fn retry_delays_and_retry_after_values_are_capped() {
        assert_eq!(retry_delay(1, Some(u64::MAX)), MAX_RETRY_DELAY);
        assert_eq!(retry_delay(62, None), MAX_RETRY_DELAY);
        assert_eq!(retry_delay(u32::MAX, None), MAX_RETRY_DELAY);

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("999999"),
        );
        assert_eq!(
            parse_retry_after_secs(&headers),
            Some(MAX_RETRY_DELAY.as_secs())
        );
    }

    #[tokio::test]
    async fn response_body_accepts_below_and_equal_limits() {
        assert_eq!(MAX_RESPONSE_BODY_BYTES, 10 * 1024 * 1024);
        for size in [7, 8] {
            let body = "x".repeat(size);
            let base = spawn_response(200, &[], &body, Duration::ZERO);
            let response = fetch_response(&base, Duration::from_secs(2)).await;
            let received = read_bounded_response_body(response, 8)
                .await
                .expect("body at or below the limit must be accepted");
            assert_eq!(received, body.as_bytes());
        }
    }

    #[tokio::test]
    async fn response_body_rejects_content_length_above_limit() {
        let base = spawn_response(200, &[], "123456789", Duration::ZERO);
        let response = fetch_response(&base, Duration::from_secs(2)).await;
        let error = read_bounded_response_body(response, 8)
            .await
            .expect_err("oversized Content-Length must be rejected");
        let context = match error {
            ResponseBodyReadError::ResourceLimit(context) => context,
            ResponseBodyReadError::Stream(error) => {
                panic!("expected Content-Length rejection, got stream error: {error}")
            }
        };
        assert_eq!(context.kind, ResourceLimitKind::ContentLength);
        assert_eq!(context.limit, 8);
        assert_eq!(context.actual, Some(9));
    }

    #[tokio::test]
    async fn response_body_rejects_streaming_overrun_without_content_length() {
        let base = spawn_raw_response(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            vec![
                (Duration::ZERO, b"5\r\n12345\r\n".to_vec()),
                (Duration::ZERO, b"4\r\n6789\r\n0\r\n\r\n".to_vec()),
            ],
        );
        let response = fetch_response(&base, Duration::from_secs(2)).await;
        let error = read_bounded_response_body(response, 8)
            .await
            .expect_err("streamed body must not exceed the limit");
        let context = match error {
            ResponseBodyReadError::ResourceLimit(context) => context,
            ResponseBodyReadError::Stream(error) => {
                panic!("expected streaming overrun, got stream error: {error}")
            }
        };
        assert_eq!(context.kind, ResourceLimitKind::StreamedBody);
        assert_eq!(context.limit, 8);
        assert_eq!(context.actual, Some(9));
    }

    #[tokio::test]
    async fn response_body_reports_stream_failure_and_cancellation() {
        let partial_base = spawn_raw_response(
            "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n",
            vec![(Duration::ZERO, b"123".to_vec())],
        );
        let partial_response = fetch_response(&partial_base, Duration::from_secs(2)).await;
        match read_bounded_response_body(partial_response, 8)
            .await
            .expect_err("truncated response must fail")
        {
            ResponseBodyReadError::Stream(error) => assert!(!error.is_timeout()),
            ResponseBodyReadError::ResourceLimit(context) => {
                panic!("expected stream failure, got resource limit: {context}")
            }
        }

        let stalled_base = spawn_raw_response(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            vec![(Duration::from_millis(200), b"0\r\n\r\n".to_vec())],
        );
        let stalled_response = fetch_response(&stalled_base, Duration::from_millis(30)).await;
        match read_bounded_response_body(stalled_response, 8)
            .await
            .expect_err("stalled response body must be cancelled by the request timeout")
        {
            ResponseBodyReadError::Stream(error) => assert!(error.is_timeout()),
            ResponseBodyReadError::ResourceLimit(context) => {
                panic!("expected cancellation, got resource limit: {context}")
            }
        }
    }

    #[test]
    fn pagination_and_bulk_bounds_accept_below_and_equal_but_reject_above() {
        for (page, per_page) in [
            (MAX_DNS_PAGE - 1, MAX_DNS_RECORDS_PER_PAGE - 1),
            (MAX_DNS_PAGE, MAX_DNS_RECORDS_PER_PAGE),
        ] {
            check_dns_pagination_bounds(Some(page), Some(per_page))
                .expect("bounded pagination must be accepted");
        }

        let page_error = check_dns_pagination_bounds(Some(MAX_DNS_PAGE + 1), None).unwrap_err();
        let page_context = resource_context(&page_error);
        assert_eq!(page_context.kind, ResourceLimitKind::Collection);
        assert_eq!(page_context.actual, Some(u64::from(MAX_DNS_PAGE) + 1));

        let per_page_error =
            check_dns_pagination_bounds(None, Some(MAX_DNS_RECORDS_PER_PAGE + 1)).unwrap_err();
        let per_page_context = resource_context(&per_page_error);
        assert_eq!(per_page_context.kind, ResourceLimitKind::Collection);
        assert_eq!(
            per_page_context.actual,
            Some(u64::from(MAX_DNS_RECORDS_PER_PAGE) + 1)
        );

        for count in [MAX_BULK_DNS_RECORDS - 1, MAX_BULK_DNS_RECORDS] {
            check_bulk_dns_bounds(count).expect("bounded bulk request must be accepted");
        }
        let bulk_error = check_bulk_dns_bounds(MAX_BULK_DNS_RECORDS + 1).unwrap_err();
        let bulk_context = resource_context(&bulk_error);
        assert_eq!(bulk_context.kind, ResourceLimitKind::Collection);
        assert_eq!(
            bulk_context.actual,
            u64::try_from(MAX_BULK_DNS_RECORDS + 1).ok()
        );
    }

    #[test]
    fn allocation_failure_is_a_structured_resource_limit_error() {
        let mut values = Vec::<u8>::new();
        let error = try_reserve_exact(&mut values, usize::MAX, "test values", 8)
            .expect_err("capacity overflow must remain recoverable");
        let context = resource_context(&error);
        assert_eq!(context.kind, ResourceLimitKind::Allocation);
        assert_eq!(context.resource, "test values");
        assert_eq!(context.limit, 8);
    }

    #[tokio::test]
    async fn verification_success_returns_true() {
        let base = spawn_response(
            200,
            &[],
            r#"{"success":true,"result":{"status":"active"}}"#,
            Duration::ZERO,
        );
        assert!(test_client(base, "valid-token")
            .verify_token()
            .await
            .expect("verification succeeds"));
    }

    #[tokio::test]
    async fn rejected_credentials_preserve_401_and_403_provider_details() {
        for status in [401, 403] {
            let base = spawn_response(
                status,
                &[("cf-ray", "abc123-LHR")],
                r#"{"success":false,"errors":[{"code":9109,"message":"Invalid access token"},{"code":10000,"message":"Authentication error"}]}"#,
                Duration::ZERO,
            );
            let error = test_client(base, "rejected-token")
                .verify_token()
                .await
                .expect_err("credentials must be rejected");
            let context = request_context(&error);
            assert_eq!(context.kind, VerificationFailureKind::Authentication);
            assert_eq!(context.status, Some(status));
            assert_eq!(context.source, VerificationErrorSource::Cloudflare);
            assert_eq!(context.operation, AUTH_OPERATION);
            assert!(!context.retryable);
            assert_eq!(context.request_id.as_deref(), Some("abc123-LHR"));
            assert_eq!(
                context
                    .provider_errors
                    .iter()
                    .filter_map(|detail| detail.code.as_deref())
                    .collect::<Vec<_>>(),
                ["9109", "10000"]
            );
            assert_eq!(
                context
                    .provider_errors
                    .iter()
                    .map(|detail| detail.message.as_str())
                    .collect::<Vec<_>>(),
                ["Invalid access token", "Authentication error"]
            );
        }
    }

    #[tokio::test]
    async fn validation_and_protocol_failures_are_not_credential_rejections() {
        let cases = [
            (
                400,
                "invalid request",
                "selected credential type and account email",
            ),
            (
                404,
                "endpoint or method",
                "Cloudflare API compatibility change",
            ),
            (
                405,
                "endpoint or method",
                "Cloudflare API compatibility change",
            ),
        ];

        for (status, message_fragment, remediation_fragment) in cases {
            let base = spawn_response(
                status,
                &[("cf-ray", "protocol123-LHR")],
                r#"{"success":false,"errors":[{"code":1000,"message":"Request rejected"}]}"#,
                Duration::ZERO,
            );
            let error = test_client(base, "protocol-token")
                .verify_token()
                .await
                .expect_err("validation and protocol failures must fail closed");
            let context = request_context(&error);
            assert_eq!(context.kind, VerificationFailureKind::MalformedResponse);
            assert_eq!(context.status, Some(status));
            assert_eq!(context.source, VerificationErrorSource::Cloudflare);
            assert!(!context.retryable);
            assert!(context.message.contains(message_fragment));
            assert!(context.remediation.contains(remediation_fragment));
            assert!(!context.message.contains("credentials"));
        }
    }

    #[tokio::test]
    async fn http_408_is_a_retryable_provider_timeout() {
        let base = spawn_response(
            408,
            &[("cf-ray", "timeout408-LHR")],
            r#"{"success":false,"errors":[{"code":408,"message":"Request timeout"}]}"#,
            Duration::ZERO,
        );
        let error = test_client(base, "timeout-token")
            .verify_token()
            .await
            .expect_err("HTTP 408 must fail as a timeout");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::Timeout);
        assert_eq!(context.status, Some(408));
        assert_eq!(context.source, VerificationErrorSource::Cloudflare);
        assert!(context.retryable);
        assert!(context.message.contains("HTTP 408"));
        assert_eq!(context.request_id.as_deref(), Some("timeout408-LHR"));
    }

    #[tokio::test]
    async fn rate_limit_preserves_retry_after_and_request_id() {
        let base = spawn_response(
            429,
            &[("retry-after", "17"), ("cf-ray", "rate123-LHR")],
            r#"{"success":false,"errors":[{"code":1015,"message":"Rate limited"}]}"#,
            Duration::ZERO,
        );
        let error = test_client(base, "rate-limited-token")
            .verify_token()
            .await
            .expect_err("rate limit must not become false");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::RateLimited);
        assert_eq!(context.status, Some(429));
        assert!(context.retryable);
        assert_eq!(context.retry_after_secs, Some(17));
        assert_eq!(context.request_id.as_deref(), Some("rate123-LHR"));
        assert_eq!(context.provider_errors[0].code.as_deref(), Some("1015"));
    }

    #[tokio::test]
    async fn rate_limit_caps_retry_after_in_error_context() {
        let base = spawn_response(
            429,
            &[("retry-after", "999999")],
            r#"{"success":false,"errors":[{"code":1015,"message":"Rate limited"}]}"#,
            Duration::ZERO,
        );
        let error = test_client(base, "rate-limited-token")
            .verify_token()
            .await
            .expect_err("rate limit must fail closed");
        let context = request_context(&error);
        assert_eq!(context.retry_after_secs, Some(MAX_RETRY_DELAY.as_secs()));
    }

    #[tokio::test]
    async fn provider_failure_preserves_status_and_safe_detail() {
        for status in [500, 503] {
            let base = spawn_response(
                status,
                &[("cf-ray", "provider123-LHR")],
                r#"{"success":false,"errors":[{"code":1001,"message":"Provider unavailable"}]}"#,
                Duration::ZERO,
            );
            let error = test_client(base, "provider-token")
                .verify_token()
                .await
                .expect_err("provider error must not become false");
            let context = request_context(&error);
            assert_eq!(context.kind, VerificationFailureKind::Provider);
            assert_eq!(context.status, Some(status));
            assert!(context.retryable);
            assert_eq!(context.provider_errors[0].message, "Provider unavailable");
        }
    }

    #[tokio::test]
    async fn malformed_success_body_is_not_treated_as_verified() {
        let base = spawn_response(200, &[], "not-json", Duration::ZERO);
        let error = test_client(base, "malformed-token")
            .verify_token()
            .await
            .expect_err("malformed success must fail closed");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::MalformedResponse);
        assert_eq!(context.status, Some(200));
        assert!(context.retryable);
        assert!(context.provider_errors.is_empty());
    }

    #[tokio::test]
    async fn network_and_timeout_failures_are_distinct() {
        let network_error = test_client("not-a-valid-url".to_string(), "network-token")
            .verify_token()
            .await
            .expect_err("invalid provider address must fail");
        let network = request_context(&network_error);
        assert_eq!(network.kind, VerificationFailureKind::Network);
        assert_eq!(network.source, VerificationErrorSource::Network);
        assert!(network.retryable);

        let base = spawn_response(200, &[], r#"{"success":true}"#, Duration::from_millis(250));
        let timeout_error = CloudflareClient::with_client(Client::new(), "timeout-token", None)
            .with_request_timeout(Duration::from_millis(30))
            .with_max_retries(0)
            .with_api_base(base)
            .verify_token()
            .await
            .expect_err("slow response must time out");
        let timeout = request_context(&timeout_error);
        assert_eq!(timeout.kind, VerificationFailureKind::Timeout);
        assert_eq!(timeout.source, VerificationErrorSource::Network);
        assert!(timeout.retryable);
    }

    #[tokio::test]
    async fn auth_body_cancellation_preserves_timeout_classification() {
        let base = spawn_raw_response(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            vec![(
                Duration::from_millis(200),
                b"0\r\n\r\n".to_vec(),
            )],
        );
        let error = CloudflareClient::with_client(Client::new(), "timeout-token", None)
            .with_request_timeout(Duration::from_millis(30))
            .with_max_retries(0)
            .with_api_base(base)
            .verify_token()
            .await
            .expect_err("stalled verification body must time out");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::Timeout);
        assert_eq!(context.source, VerificationErrorSource::Network);
        assert!(context.retryable);
    }

    #[tokio::test]
    async fn provider_errors_redact_exact_credentials_from_all_outputs() {
        let secret = "secret-token-value";
        let body = format!(
            r#"{{"success":false,"errors":[{{"code":9109,"message":"Provided {secret} via Authorization: Bearer {secret} token={secret}"}}]}}"#
        );
        let base = spawn_response(401, &[], &body, Duration::ZERO);
        let error = test_client(base, secret)
            .verify_token()
            .await
            .expect_err("secret-bearing rejection must fail");
        let context = request_context(&error);
        let serialized = serde_json::to_string(context).expect("serialize context");
        let display = error.to_string();
        let debug = format!("{error:?}");
        for output in [serialized, display, debug] {
            assert!(!output.contains(secret), "secret leaked in {output}");
        }
        assert!(context.provider_errors[0].message.contains("[redacted]"));
    }
}

#[cfg(test)]
mod zone_analytics_graphql_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc::{self, Receiver};
    use std::thread;

    fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = stream.read(&mut buffer).expect("read request");
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let mut content_length = 0_usize;
            for line in headers.lines() {
                let lower = line.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    content_length = value.trim().parse().expect("content length");
                }
            }
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        request
    }

    fn spawn_graphql_response(body: &str) -> (String, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind analytics server");
        let address = listener.local_addr().expect("analytics server address");
        let response_body = body.to_string();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept analytics request");
            let request = read_http_request(&mut stream);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\ncf-ray: analytics-LHR\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write analytics response");
            sender
                .send(String::from_utf8_lossy(&request).into_owned())
                .expect("capture analytics request");
        });
        (format!("http://{address}"), receiver)
    }

    fn test_client(base: String) -> CloudflareClient {
        CloudflareClient::new("analytics-token", None)
            .with_max_retries(0)
            .with_api_base(base)
            .with_request_timeout(Duration::from_secs(2))
    }

    fn request_context(error: &CloudflareError) -> &CloudflareRequestError {
        match error {
            CloudflareError::Request(context) => context,
            other => panic!("expected structured analytics request error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn graphql_analytics_posts_query_and_maps_flat_ui_contract() {
        let (base, request) = spawn_graphql_response(
            r#"{"data":{"viewer":{"zones":[{"totals":[{"sum":{"requests":19,"bytes":596139,"threats":6,"pageViews":2},"uniq":{"uniques":15}}],"timeseries":[{"dimensions":{"datetimeFiveMinutes":"2026-08-05T10:00:00Z"},"sum":{"requests":15,"bytes":312740,"threats":6,"pageViews":1},"uniq":{"uniques":11}},{"dimensions":{"datetimeFiveMinutes":"2026-08-05T10:05:00Z"},"sum":{"requests":4,"bytes":283399,"threats":0,"pageViews":1},"uniq":{"uniques":4}}]}]}},"errors":null}"#,
        );
        let result = test_client(base)
            .get_zone_analytics("zone-id", "-6h", "now", Some(true))
            .await
            .expect("GraphQL analytics result");
        let raw_request = request
            .recv_timeout(Duration::from_secs(2))
            .expect("captured GraphQL request");
        let lower_request = raw_request.to_ascii_lowercase();
        assert!(lower_request.starts_with("post /graphql http/1.1"));
        assert!(lower_request.contains("authorization: bearer analytics-token"));
        let request_body: Value = serde_json::from_str(
            raw_request
                .split_once("\r\n\r\n")
                .expect("HTTP request body")
                .1,
        )
        .expect("GraphQL JSON payload");
        let query = request_body["query"].as_str().expect("GraphQL query");
        assert!(query.contains("totals: httpRequests1mGroups"));
        assert!(query.contains("timeseries: httpRequests1mGroups"));
        assert!(query.contains("datetimeFiveMinutes"));
        assert!(query.contains("pageViews"));
        assert!(query.contains("uniques"));
        assert_eq!(request_body["variables"]["zoneTag"], "zone-id");
        let start = request_body["variables"]["start"]
            .as_str()
            .expect("start variable");
        let end = request_body["variables"]["end"]
            .as_str()
            .expect("end variable");
        assert_ne!(start, "-6h");
        assert_ne!(end, "now");
        assert!(start.ends_with('Z'));
        assert!(end.ends_with('Z'));

        assert_eq!(result["totals"]["requests"], 19);
        assert_eq!(result["totals"]["bandwidth"], 596139);
        assert_eq!(result["totals"]["threats"], 6);
        assert_eq!(result["totals"]["pageviews"], 2);
        assert_eq!(result["totals"]["uniques"], 15);
        assert_eq!(result["timeseries"][0]["bandwidth"], 312740);
        assert_eq!(result["timeseries"][0]["until"], "2026-08-05T10:05:00Z");
        assert_eq!(result["timeseries"][1]["until"], end);
    }

    #[tokio::test]
    async fn graphql_analytics_rejects_errors_even_with_http_200() {
        let (base, _request) = spawn_graphql_response(
            r#"{"data":null,"errors":[{"message":"Analytics dataset unavailable","extensions":{"code":"DATASET_UNAVAILABLE"}}]}"#,
        );
        let error = test_client(base)
            .get_zone_analytics(
                "zone-id",
                "2026-08-05T10:00:00Z",
                "2026-08-05T11:00:00Z",
                None,
            )
            .await
            .expect_err("GraphQL errors must fail the request");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::Provider);
        assert_eq!(context.status, Some(200));
        assert_eq!(context.request_id.as_deref(), Some("analytics-LHR"));
        assert_eq!(context.provider_errors.len(), 1);
        assert_eq!(
            context.provider_errors[0].code.as_deref(),
            Some("DATASET_UNAVAILABLE")
        );
    }

    #[tokio::test]
    async fn graphql_analytics_rejects_missing_zone_data() {
        let (base, _request) =
            spawn_graphql_response(r#"{"data":{"viewer":{"zones":[]}},"errors":null}"#);
        let error = test_client(base)
            .get_zone_analytics(
                "missing-zone",
                "2026-08-05T10:00:00Z",
                "2026-08-05T11:00:00Z",
                None,
            )
            .await
            .expect_err("empty zones must not become zero analytics");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::MalformedResponse);
        assert_eq!(context.status, Some(200));
        assert_eq!(context.request_id.as_deref(), Some("analytics-LHR"));
    }

    #[tokio::test]
    async fn graphql_analytics_rejects_malformed_metric_scalars() {
        let (base, _request) = spawn_graphql_response(
            r#"{"data":{"viewer":{"zones":[{"totals":[{"sum":{"requests":"nineteen","bytes":1,"threats":0,"pageViews":1},"uniq":{"uniques":1}}],"timeseries":[]}]}},"errors":null}"#,
        );
        let error = test_client(base)
            .get_zone_analytics(
                "zone-id",
                "2026-08-05T10:00:00Z",
                "2026-08-05T11:00:00Z",
                None,
            )
            .await
            .expect_err("malformed metrics must not become zero analytics");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::MalformedResponse);
        assert_eq!(context.status, Some(200));
    }
}

#[cfg(test)]
mod dns_mutation_contract_tests {
    use super::*;

    #[test]
    fn dns_record_input_omits_absent_optional_fields() {
        let value = serde_json::to_value(DNSRecordInput {
            r#type: "TXT".to_string(),
            name: "example.com".to_string(),
            content: "v=spf1 -all".to_string(),
            comment: None,
            ttl: Some(300),
            priority: None,
            proxied: None,
        })
        .expect("DNS mutation input should serialize");

        assert_eq!(
            value,
            serde_json::json!({
                "type": "TXT",
                "name": "example.com",
                "content": "v=spf1 -all",
                "ttl": 300
            })
        );
    }

    #[test]
    fn dns_mutation_response_classifies_status_and_envelope() {
        assert_eq!(
            classify_dns_mutation_response(403, None),
            DnsMutationResponseKind::HttpFailure
        );
        assert_eq!(
            classify_dns_mutation_response(200, Some(&serde_json::json!({"success": true}))),
            DnsMutationResponseKind::Success
        );
        assert_eq!(
            classify_dns_mutation_response(
                200,
                Some(&serde_json::json!({
                    "success": false,
                    "errors": [{"code": 1004, "message": "DNS validation failed"}]
                }))
            ),
            DnsMutationResponseKind::ProviderFailure
        );
        assert_eq!(
            classify_dns_mutation_response(200, Some(&serde_json::json!({"result": {}}))),
            DnsMutationResponseKind::Malformed
        );
    }
}
