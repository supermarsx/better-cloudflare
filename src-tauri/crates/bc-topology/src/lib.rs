//! DNS topology resolution engine.
//!
//! Resolves hostname CNAME chains, IPv4/IPv6 addresses, PTR reverse
//! lookups, IP geolocation (multiple providers), and HTTP/TCP service
//! probing. Includes an in-process cache with configurable TTL.

use chrono::Utc;
use hickory_resolver::config::{NameServerConfig, ResolverConfig, ResolverOpts, CLOUDFLARE};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::{RData, RecordType};
use hickory_resolver::TokioResolver;
use reqwest::redirect::Policy;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::IpAddr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{RwLock, Semaphore};

mod limits;
pub use limits::*;

// ─── Public types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostnameChainResult {
    pub name: String,
    pub chain: Vec<String>,
    pub terminal: String,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub reverse_hostnames: Vec<ReverseHostnameResult>,
    pub geo_by_ip: Vec<IpGeoResult>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReverseHostnameResult {
    pub ip: String,
    pub hostnames: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpGeoResult {
    pub ip: String,
    pub country: String,
    pub country_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceProbeResult {
    pub host: String,
    pub https_up: bool,
    pub http_up: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TcpServiceProbeResult {
    pub host: String,
    pub port: u16,
    pub up: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TopologyBatchResult {
    pub resolutions: Vec<HostnameChainResult>,
    pub probes: Vec<ServiceProbeResult>,
    pub tcp_probes: Vec<TcpServiceProbeResult>,
}

// ─── Cache infrastructure ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct TopologyHostCacheEntry {
    ts_ms: i64,
    value: HostnameChainResult,
}

#[derive(Debug, Clone)]
struct TopologyIpGeoCacheEntry {
    ts_ms: i64,
    value: Option<IpGeoResult>,
}

const TOPOLOGY_HOST_CACHE_TTL_MS: i64 = 5 * 60 * 1000;
const TOPOLOGY_HOST_CACHE_MAX_ENTRIES: usize = 6000;
const TOPOLOGY_IP_GEO_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const TOPOLOGY_IP_GEO_CACHE_MAX_ENTRIES: usize = 10000;

fn topology_host_cache() -> &'static RwLock<HashMap<String, TopologyHostCacheEntry>> {
    static CACHE: OnceLock<RwLock<HashMap<String, TopologyHostCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn topology_ip_geo_cache() -> &'static RwLock<HashMap<String, TopologyIpGeoCacheEntry>> {
    static CACHE: OnceLock<RwLock<HashMap<String, TopologyIpGeoCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn topology_request_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_TOPOLOGY_REQUESTS)))
}

fn propagation_request_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_PROPAGATION_REQUESTS)))
}

// ─── Helpers ───────────────────────────────────────────────────────────────

fn normalize_domain(input: &str) -> String {
    input.trim().trim_end_matches('.').to_lowercase()
}

fn bounded_domain(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_end_matches('.');
    if trimmed.is_empty() || trimmed.len() > MAX_HOSTNAME_BYTES {
        return None;
    }
    let normalized = trimmed.to_lowercase();
    if normalized.is_empty() || normalized.len() > MAX_HOSTNAME_BYTES {
        None
    } else {
        Some(normalized)
    }
}

fn bounded_error(message: impl AsRef<str>) -> String {
    let message = message.as_ref();
    if message.len() <= MAX_ERROR_BYTES {
        return message.to_string();
    }
    let mut end = MAX_ERROR_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &message[..end])
}

#[cfg(test)]
static TEST_NETWORK_STARTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
fn note_network_start() {
    TEST_NETWORK_STARTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(not(test))]
fn note_network_start() {}

async fn read_json_limited<T: DeserializeOwned>(
    mut response: reqwest::Response,
    max_bytes: usize,
    timeout: Duration,
) -> Option<T> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return None;
    }
    tokio::time::timeout(timeout, async move {
        let mut bytes = Vec::new();
        if let Some(length) = response.content_length() {
            bytes.try_reserve(length as usize).ok()?;
        }
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                return None;
            }
            bytes.try_reserve(chunk.len()).ok()?;
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).ok()
    })
    .await
    .ok()
    .flatten()
}

fn bounded_answers<I>(answers: I) -> Result<Vec<String>, String>
where
    I: IntoIterator<Item = String>,
{
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    let mut retained_bytes = 0usize;
    for answer in answers {
        let answer = answer.trim().to_string();
        if answer.is_empty() {
            continue;
        }
        if answer.len() > MAX_DNS_ANSWER_BYTES {
            return Err(format!(
                "DNS answer exceeds the safe {MAX_DNS_ANSWER_BYTES} byte limit"
            ));
        }
        if !seen.insert(answer.clone()) {
            continue;
        }
        if output.len() >= MAX_DNS_ANSWERS {
            return Err(format!(
                "DNS answer count exceeds the safe {MAX_DNS_ANSWERS} item limit"
            ));
        }
        retained_bytes = retained_bytes.saturating_add(answer.len());
        if retained_bytes > MAX_DNS_ANSWER_TOTAL_BYTES {
            return Err(format!(
                "DNS answers exceed the safe {MAX_DNS_ANSWER_TOTAL_BYTES} byte aggregate limit"
            ));
        }
        output.push(answer);
    }
    output.sort();
    Ok(output)
}

async fn bounded_parallel_map<T, U, F, Fut>(
    items: Vec<T>,
    concurrency: usize,
    operation: F,
) -> Vec<U>
where
    T: Send + 'static,
    U: Send + 'static,
    F: Fn(T) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = U> + Send + 'static,
{
    let total = items.len();
    let mut ordered: Vec<Option<U>> = (0..total).map(|_| None).collect();
    let mut pending = items.into_iter().enumerate();
    let mut tasks = tokio::task::JoinSet::new();
    let concurrency = concurrency.max(1);

    for _ in 0..concurrency {
        let Some((index, item)) = pending.next() else {
            break;
        };
        let operation = operation.clone();
        tasks.spawn(async move { (index, operation(item).await) });
    }
    while let Some(joined) = tasks.join_next().await {
        if let Ok((index, value)) = joined {
            ordered[index] = Some(value);
        }
        if let Some((index, item)) = pending.next() {
            let operation = operation.clone();
            tasks.spawn(async move { (index, operation(item).await) });
        }
    }
    ordered.into_iter().flatten().collect()
}

#[derive(Debug, Deserialize)]
struct DnsGoogleAnswer {
    data: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DnsGoogleResponse {
    #[serde(rename = "Answer")]
    answer: Option<Vec<DnsGoogleAnswer>>,
}

#[derive(Debug, Deserialize)]
struct IpWhoisResponse {
    success: Option<bool>,
    country: Option<String>,
    country_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpApiCoResponse {
    country_name: Option<String>,
    country_code: Option<String>,
    error: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct IpApiComResponse {
    status: Option<String>,
    country: Option<String>,
    #[serde(rename = "countryCode")]
    country_code: Option<String>,
}

// ─── DoH queries ───────────────────────────────────────────────────────────

async fn query_doh_records(
    client: &reqwest::Client,
    doh_endpoints: &[String],
    name: &str,
    record_type: &str,
    lookup_timeout_ms: u32,
) -> Vec<String> {
    if doh_endpoints.is_empty() {
        return Vec::new();
    }

    async fn query_one_doh(
        client: reqwest::Client,
        endpoint: String,
        name: String,
        record_type: String,
        lookup_timeout_ms: u32,
    ) -> Option<Vec<String>> {
        note_network_start();
        let send_fut = client
            .get(endpoint)
            .header("accept", "application/dns-json")
            .query(&[("name", name.as_str()), ("type", record_type.as_str())])
            .send();
        let Ok(resp) = tokio::time::timeout(
            Duration::from_millis(u64::from(lookup_timeout_ms)),
            send_fut,
        )
        .await
        else {
            return None;
        };
        let Ok(resp) = resp else { return None };
        if !resp.status().is_success() {
            return None;
        }
        let payload = read_json_limited::<DnsGoogleResponse>(
            resp,
            MAX_DOH_RESPONSE_BYTES,
            Duration::from_millis(u64::from(lookup_timeout_ms)),
        )
        .await?;
        let answers = payload
            .answer
            .unwrap_or_default()
            .into_iter()
            .filter_map(|answer| answer.data)
            .filter_map(|raw| {
                if record_type == "CNAME" {
                    bounded_domain(&raw)
                } else {
                    Some(raw)
                }
            });
        bounded_answers(answers)
            .ok()
            .filter(|answers| !answers.is_empty())
    }

    let mut set = tokio::task::JoinSet::new();
    for endpoint in doh_endpoints.iter().take(3) {
        set.spawn(query_one_doh(
            client.clone(),
            endpoint.clone(),
            name.to_string(),
            record_type.to_string(),
            lookup_timeout_ms,
        ));
    }
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(out)) = joined {
            return out;
        }
    }
    Vec::new()
}

// ─── DNS chain resolution ──────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn resolve_chain_for_host(
    resolver: &TokioResolver,
    client: &reqwest::Client,
    doh_endpoints: &[String],
    host: &str,
    max_hops: usize,
    scan_resolution_chain: bool,
    lookup_timeout_ms: u32,
    disable_ptr_lookups: bool,
) -> HostnameChainResult {
    let name = normalize_domain(host);
    let mut resource_error = None;
    if name.is_empty() {
        return HostnameChainResult {
            name,
            chain: Vec::new(),
            terminal: String::new(),
            ipv4: Vec::new(),
            ipv6: Vec::new(),
            reverse_hostnames: Vec::new(),
            geo_by_ip: Vec::new(),
            error: Some("empty hostname".to_string()),
        };
    }

    let mut chain = vec![name.clone()];
    let mut seen = HashSet::new();
    seen.insert(name.clone());
    let mut cur = name.clone();

    if scan_resolution_chain {
        for _ in 0..max_hops {
            let cname_lookup =
                tokio::time::timeout(Duration::from_millis(u64::from(lookup_timeout_ms)), async {
                    note_network_start();
                    resolver.lookup(cur.clone(), RecordType::CNAME).await
                })
                .await;
            let direct_next = match cname_lookup {
                Ok(Ok(lookup)) => lookup.answers().iter().find_map(|record| {
                    if let RData::CNAME(cname) = &record.data {
                        bounded_domain(&cname.to_string())
                    } else {
                        None
                    }
                }),
                Err(_) | Ok(Err(_)) => None,
            };
            let next = if direct_next.is_some() {
                direct_next
            } else {
                query_doh_records(client, doh_endpoints, &cur, "CNAME", lookup_timeout_ms)
                    .await
                    .into_iter()
                    .next()
            };
            let Some(next_name) = next else { break };
            if seen.contains(&next_name) {
                break;
            }
            chain.push(next_name.clone());
            seen.insert(next_name.clone());
            cur = next_name;
        }
    }

    let (v4_lookup, v6_lookup) = tokio::join!(
        tokio::time::timeout(Duration::from_millis(u64::from(lookup_timeout_ms)), async {
            note_network_start();
            resolver.ipv4_lookup(cur.clone()).await
        }),
        tokio::time::timeout(Duration::from_millis(u64::from(lookup_timeout_ms)), async {
            note_network_start();
            resolver.ipv6_lookup(cur.clone()).await
        })
    );

    let mut ipv4 = Vec::new();
    let mut seen_ipv4 = HashSet::new();
    if let Ok(Ok(v4)) = v4_lookup {
        for record in v4.answers() {
            if let RData::A(ip) = &record.data {
                let value = ip.to_string();
                if !seen_ipv4.insert(value.clone()) {
                    continue;
                }
                if ipv4.len() >= MAX_IPS_PER_FAMILY {
                    resource_error = Some(format!(
                        "IPv4 answer count exceeds the safe {MAX_IPS_PER_FAMILY} item limit"
                    ));
                    break;
                }
                ipv4.push(value);
            }
        }
    }

    let mut ipv6 = Vec::new();
    let mut seen_ipv6 = HashSet::new();
    if let Ok(Ok(v6)) = v6_lookup {
        for record in v6.answers() {
            if let RData::AAAA(ip) = &record.data {
                let value = ip.to_string();
                if !seen_ipv6.insert(value.clone()) {
                    continue;
                }
                if ipv6.len() >= MAX_IPS_PER_FAMILY {
                    resource_error = Some(format!(
                        "IPv6 answer count exceeds the safe {MAX_IPS_PER_FAMILY} item limit"
                    ));
                    break;
                }
                ipv6.push(value);
            }
        }
    }

    if ipv4.is_empty() || ipv6.is_empty() {
        let (doh_v4, doh_v6) = tokio::join!(
            async {
                if ipv4.is_empty() {
                    query_doh_records(client, doh_endpoints, &cur, "A", lookup_timeout_ms).await
                } else {
                    Vec::new()
                }
            },
            async {
                if ipv6.is_empty() {
                    query_doh_records(client, doh_endpoints, &cur, "AAAA", lookup_timeout_ms).await
                } else {
                    Vec::new()
                }
            }
        );
        if ipv4.is_empty() {
            ipv4 = doh_v4;
            if ipv4.len() > MAX_IPS_PER_FAMILY {
                ipv4.truncate(MAX_IPS_PER_FAMILY);
                resource_error = Some(format!(
                    "IPv4 answer count exceeds the safe {MAX_IPS_PER_FAMILY} item limit"
                ));
            }
        }
        if ipv6.is_empty() {
            ipv6 = doh_v6;
            if ipv6.len() > MAX_IPS_PER_FAMILY {
                ipv6.truncate(MAX_IPS_PER_FAMILY);
                resource_error = Some(format!(
                    "IPv6 answer count exceeds the safe {MAX_IPS_PER_FAMILY} item limit"
                ));
            }
        }
    }

    let mut reverse_hostnames = Vec::new();
    if !disable_ptr_lookups {
        let mut all_ips = Vec::new();
        all_ips.extend(ipv4.iter().cloned());
        all_ips.extend(ipv6.iter().cloned());
        for ip in all_ips {
            let Ok(parsed) = ip.parse::<IpAddr>() else {
                continue;
            };
            let mut names = Vec::new();
            let mut seen_names = HashSet::new();
            let ptr_lookup =
                tokio::time::timeout(Duration::from_millis(u64::from(lookup_timeout_ms)), async {
                    note_network_start();
                    resolver.reverse_lookup(parsed).await
                })
                .await;
            if let Ok(Ok(ptr_lookup)) = ptr_lookup {
                for record in ptr_lookup.answers() {
                    if let RData::PTR(name) = &record.data {
                        let Some(host) = bounded_domain(&name.to_string()) else {
                            continue;
                        };
                        if seen_names.insert(host.clone()) {
                            if names.len() >= MAX_REVERSE_HOSTNAMES_PER_IP {
                                resource_error = Some(format!(
                                    "PTR answer count exceeds the safe {MAX_REVERSE_HOSTNAMES_PER_IP} item limit"
                                ));
                                break;
                            }
                            names.push(host);
                        }
                    }
                }
            }
            if !names.is_empty() {
                reverse_hostnames.push(ReverseHostnameResult {
                    ip,
                    hostnames: names,
                });
            }
        }
    }

    let unresolved = chain.len() <= 1 && ipv4.is_empty() && ipv6.is_empty();
    HostnameChainResult {
        name,
        chain,
        terminal: cur,
        ipv4,
        ipv6,
        reverse_hostnames,
        geo_by_ip: Vec::new(),
        error: if let Some(error) = resource_error {
            Some(error)
        } else if unresolved {
            Some("no CNAME/A/AAAA records found".to_string())
        } else {
            None
        },
    }
}

// ─── IP Geolocation ────────────────────────────────────────────────────────

fn resolve_internal_ip_geo(ip: &str) -> Option<IpGeoResult> {
    let parsed = ip.parse::<IpAddr>().ok()?;
    match parsed {
        IpAddr::V4(v4) => {
            if v4.is_loopback() {
                return Some(IpGeoResult {
                    ip: ip.to_string(),
                    country: "Loopback".to_string(),
                    country_code: Some("LO".to_string()),
                });
            }
            if v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_unspecified()
                || v4.is_documentation()
            {
                return Some(IpGeoResult {
                    ip: ip.to_string(),
                    country: "Private/Reserved".to_string(),
                    country_code: Some("ZZ".to_string()),
                });
            }
            None
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            let is_doc = seg[0] == 0x2001 && seg[1] == 0x0db8;
            if v6.is_loopback() {
                return Some(IpGeoResult {
                    ip: ip.to_string(),
                    country: "Loopback".to_string(),
                    country_code: Some("LO".to_string()),
                });
            }
            if v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
                || v6.is_unspecified()
                || is_doc
            {
                return Some(IpGeoResult {
                    ip: ip.to_string(),
                    country: "Private/Reserved".to_string(),
                    country_code: Some("ZZ".to_string()),
                });
            }
            None
        }
    }
}

async fn fetch_ip_geo_ipwhois(
    client: &reqwest::Client,
    ip: &str,
    lookup_timeout_ms: u32,
) -> Option<IpGeoResult> {
    let url = format!("https://ipwho.is/{}", ip);
    note_network_start();
    let send_fut = client.get(url).send();
    let Ok(resp) = tokio::time::timeout(
        Duration::from_millis(u64::from(lookup_timeout_ms).saturating_mul(2)),
        send_fut,
    )
    .await
    else {
        return None;
    };
    let Ok(resp) = resp else { return None };
    if !resp.status().is_success() {
        return None;
    }
    let payload = read_json_limited::<IpWhoisResponse>(
        resp,
        MAX_GEO_RESPONSE_BYTES,
        Duration::from_millis(u64::from(lookup_timeout_ms).saturating_mul(2)),
    )
    .await?;
    if payload.success == Some(false) {
        return None;
    }
    let country = payload.country.unwrap_or_default().trim().to_string();
    if country.is_empty() || country.len() > MAX_GEO_COUNTRY_BYTES {
        return None;
    }
    let country_code = payload
        .country_code
        .map(|value| value.trim().to_uppercase())
        .filter(|value| !value.is_empty() && value.len() <= MAX_GEO_COUNTRY_CODE_BYTES);
    Some(IpGeoResult {
        ip: ip.to_string(),
        country,
        country_code,
    })
}

async fn fetch_ip_geo_ipapi_co(
    client: &reqwest::Client,
    ip: &str,
    lookup_timeout_ms: u32,
) -> Option<IpGeoResult> {
    let url = format!("https://ipapi.co/{}/json/", ip);
    note_network_start();
    let send_fut = client.get(url).send();
    let Ok(resp) = tokio::time::timeout(
        Duration::from_millis(u64::from(lookup_timeout_ms).saturating_mul(2)),
        send_fut,
    )
    .await
    else {
        return None;
    };
    let Ok(resp) = resp else { return None };
    if !resp.status().is_success() {
        return None;
    }
    let payload = read_json_limited::<IpApiCoResponse>(
        resp,
        MAX_GEO_RESPONSE_BYTES,
        Duration::from_millis(u64::from(lookup_timeout_ms).saturating_mul(2)),
    )
    .await?;
    if payload.error == Some(true) {
        return None;
    }
    let country = payload.country_name.unwrap_or_default().trim().to_string();
    if country.is_empty() || country.len() > MAX_GEO_COUNTRY_BYTES {
        return None;
    }
    let country_code = payload
        .country_code
        .map(|value| value.trim().to_uppercase())
        .filter(|value| !value.is_empty() && value.len() <= MAX_GEO_COUNTRY_CODE_BYTES);
    Some(IpGeoResult {
        ip: ip.to_string(),
        country,
        country_code,
    })
}

async fn fetch_ip_geo_ip_api(
    client: &reqwest::Client,
    ip: &str,
    lookup_timeout_ms: u32,
) -> Option<IpGeoResult> {
    let url = format!(
        "https://ip-api.com/json/{}?fields=status,country,countryCode",
        ip
    );
    note_network_start();
    let send_fut = client.get(url).send();
    let Ok(resp) = tokio::time::timeout(
        Duration::from_millis(u64::from(lookup_timeout_ms).saturating_mul(2)),
        send_fut,
    )
    .await
    else {
        return None;
    };
    let Ok(resp) = resp else { return None };
    if !resp.status().is_success() {
        return None;
    }
    let payload = read_json_limited::<IpApiComResponse>(
        resp,
        MAX_GEO_RESPONSE_BYTES,
        Duration::from_millis(u64::from(lookup_timeout_ms).saturating_mul(2)),
    )
    .await?;
    if payload.status.unwrap_or_default().to_lowercase() != "success" {
        return None;
    }
    let country = payload.country.unwrap_or_default().trim().to_string();
    if country.is_empty() || country.len() > MAX_GEO_COUNTRY_BYTES {
        return None;
    }
    let country_code = payload
        .country_code
        .map(|value| value.trim().to_uppercase())
        .filter(|value| !value.is_empty() && value.len() <= MAX_GEO_COUNTRY_CODE_BYTES);
    Some(IpGeoResult {
        ip: ip.to_string(),
        country,
        country_code,
    })
}

async fn fetch_ip_geo(
    client: &reqwest::Client,
    ip: &str,
    lookup_timeout_ms: u32,
    geo_provider: &str,
) -> Option<IpGeoResult> {
    let provider = geo_provider.trim().to_lowercase();
    match provider.as_str() {
        "internal" => resolve_internal_ip_geo(ip),
        "ipwhois" => fetch_ip_geo_ipwhois(client, ip, lookup_timeout_ms).await,
        "ipapi_co" => fetch_ip_geo_ipapi_co(client, ip, lookup_timeout_ms).await,
        "ip_api" => fetch_ip_geo_ip_api(client, ip, lookup_timeout_ms).await,
        _ => {
            if let Some(internal) = resolve_internal_ip_geo(ip) {
                return Some(internal);
            }
            if let Some(value) = fetch_ip_geo_ipwhois(client, ip, lookup_timeout_ms).await {
                return Some(value);
            }
            if let Some(value) = fetch_ip_geo_ipapi_co(client, ip, lookup_timeout_ms).await {
                return Some(value);
            }
            fetch_ip_geo_ip_api(client, ip, lookup_timeout_ms).await
        }
    }
}

async fn resolve_geo_for_ips(
    client: &reqwest::Client,
    ips: &[String],
    lookup_timeout_ms: u32,
    geo_provider: &str,
) -> HashMap<String, IpGeoResult> {
    let now_ms = Utc::now().timestamp_millis();
    let mut out = HashMap::new();
    let mut unresolved = Vec::new();
    {
        let cache = topology_ip_geo_cache().read().await;
        for ip in ips {
            let cache_key = format!("{}|{}", geo_provider, ip);
            if let Some(entry) = cache.get(&cache_key) {
                if now_ms - entry.ts_ms <= TOPOLOGY_IP_GEO_CACHE_TTL_MS {
                    if let Some(value) = &entry.value {
                        out.insert(ip.clone(), value.clone());
                    }
                    continue;
                }
            }
            unresolved.push(ip.clone());
        }
    }

    if !unresolved.is_empty() {
        let client = client.clone();
        let geo_provider = geo_provider.to_string();
        let geo_provider_for_tasks = geo_provider.clone();
        let resolved =
            bounded_parallel_map(unresolved, NETWORK_CONCURRENCY, move |ip_owned: String| {
                let client = client.clone();
                let geo_provider = geo_provider_for_tasks.clone();
                async move {
                    let value =
                        fetch_ip_geo(&client, &ip_owned, lookup_timeout_ms, &geo_provider).await;
                    (ip_owned, value)
                }
            })
            .await;
        let write_ts = Utc::now().timestamp_millis();
        let mut cache_updates: Vec<(String, Option<IpGeoResult>)> = Vec::new();
        for (ip, maybe_geo) in resolved {
            if let Some(geo) = &maybe_geo {
                out.insert(ip.clone(), geo.clone());
            }
            cache_updates.push((ip, maybe_geo));
        }
        if !cache_updates.is_empty() {
            let mut cache = topology_ip_geo_cache().write().await;
            for (ip, value) in cache_updates {
                let key = format!("{}|{}", geo_provider, ip);
                cache.insert(
                    key,
                    TopologyIpGeoCacheEntry {
                        ts_ms: write_ts,
                        value,
                    },
                );
            }
            cache.retain(|_, entry| write_ts - entry.ts_ms <= TOPOLOGY_IP_GEO_CACHE_TTL_MS);
            if cache.len() > TOPOLOGY_IP_GEO_CACHE_MAX_ENTRIES {
                let mut oldest: Vec<(String, i64)> =
                    cache.iter().map(|(k, v)| (k.clone(), v.ts_ms)).collect();
                oldest.sort_by_key(|(_, ts)| *ts);
                let remove_count = cache.len() - TOPOLOGY_IP_GEO_CACHE_MAX_ENTRIES;
                for (k, _) in oldest.into_iter().take(remove_count) {
                    cache.remove(&k);
                }
            }
        }
    }
    out
}

// ─── Service probing ───────────────────────────────────────────────────────

async fn probe_url(client: &reqwest::Client, url: String) -> bool {
    note_network_start();
    let fut = client.get(url).send();
    let resp = tokio::time::timeout(Duration::from_secs(5), fut).await;
    matches!(resp, Ok(Ok(_)))
}

async fn probe_tcp(host: &str, port: u16, timeout_ms: u32) -> bool {
    note_network_start();
    let fut = tokio::net::TcpStream::connect((host, port));
    matches!(
        tokio::time::timeout(Duration::from_millis(u64::from(timeout_ms)), fut).await,
        Ok(Ok(_))
    )
}

// ─── DNS resolver construction ─────────────────────────────────────────────

pub fn resolve_dns_server(
    dns_server: Option<&str>,
    custom_dns_server: Option<&str>,
    legacy_provider: Option<&str>,
) -> String {
    let selected = dns_server.unwrap_or("1.1.1.1").trim();
    if selected.eq_ignore_ascii_case("custom") {
        let custom = custom_dns_server.unwrap_or("").trim();
        if !custom.is_empty() {
            return custom.to_string();
        }
    }
    if !selected.is_empty() && selected != "__legacy__" {
        return selected.to_string();
    }
    match legacy_provider
        .unwrap_or("cloudflare")
        .trim()
        .to_lowercase()
        .as_str()
    {
        "google" => "8.8.8.8".to_string(),
        "quad9" => "9.9.9.9".to_string(),
        "cloudflare" => "1.1.1.1".to_string(),
        _ => "1.1.1.1".to_string(),
    }
}

pub fn build_dns_resolver(
    dns_server: Option<&str>,
    custom_dns_server: Option<&str>,
    legacy_provider: Option<&str>,
) -> Result<TokioResolver, String> {
    let target = resolve_dns_server(dns_server, custom_dns_server, legacy_provider);
    if let Ok(ip) = target.parse() {
        let mut opts = ResolverOpts::default();
        opts.timeout = Duration::from_secs(2);
        opts.attempts = 1;
        let config =
            ResolverConfig::from_parts(None, vec![], vec![NameServerConfig::udp_and_tcp(ip)]);
        return TokioResolver::builder_with_config(config, TokioRuntimeProvider::default())
            .with_options(opts)
            .build()
            .map_err(|e| e.to_string());
    }
    match TokioResolver::builder_tokio().and_then(|builder| builder.build()) {
        Ok(resolver) => Ok(resolver),
        Err(_) => TokioResolver::builder_with_config(
            ResolverConfig::udp_and_tcp(&CLOUDFLARE),
            TokioRuntimeProvider::default(),
        )
        .build()
        .map_err(|e| e.to_string()),
    }
}

fn map_dns_server_to_doh_endpoint(dns_server: &str, custom_doh_url: Option<&str>) -> String {
    let server = dns_server.trim();
    if server.eq_ignore_ascii_case("custom") {
        let custom = custom_doh_url.unwrap_or("").trim();
        if !custom.is_empty() {
            return custom.to_string();
        }
    }
    match server {
        "1.1.1.1" | "1.0.0.1" => "https://cloudflare-dns.com/dns-query".to_string(),
        "8.8.8.8" | "8.8.4.4" => "https://dns.google/resolve".to_string(),
        "9.9.9.9" | "149.112.112.112" => "https://dns.quad9.net:5053/dns-query".to_string(),
        _ => {
            let custom = custom_doh_url.unwrap_or("").trim();
            if !custom.is_empty() {
                custom.to_string()
            } else {
                "https://cloudflare-dns.com/dns-query".to_string()
            }
        }
    }
}

fn resolve_doh_endpoints(
    dns_server: Option<&str>,
    custom_dns_server: Option<&str>,
    custom_doh_url: Option<&str>,
    legacy_provider: Option<&str>,
) -> Result<Vec<String>, String> {
    let selected_dns = resolve_dns_server(dns_server, custom_dns_server, legacy_provider);
    let preferred = map_dns_server_to_doh_endpoint(&selected_dns, custom_doh_url);
    let mut out = vec![
        preferred,
        "https://cloudflare-dns.com/dns-query".to_string(),
        "https://dns.google/resolve".to_string(),
        "https://dns.quad9.net:5053/dns-query".to_string(),
    ];
    let mut seen = HashSet::new();
    out.retain(|value| seen.insert(value.clone()));
    for endpoint in &out {
        validate_https_url("DoH endpoint", endpoint)?;
    }
    Ok(out)
}

// ─── Main batch resolver ──────────────────────────────────────────────────

fn validate_text_collection(
    label: &'static str,
    values: &[String],
    max_count: usize,
    max_item_bytes: usize,
    max_total_bytes: usize,
) -> Result<(), String> {
    if values.len() > max_count {
        return Err(format!(
            "{label} count exceeds the safe {max_count} item limit (actual: {})",
            values.len()
        ));
    }
    let mut total_bytes = 0usize;
    for value in values {
        let trimmed = value.trim().trim_end_matches('.');
        if trimmed.len() > max_item_bytes {
            return Err(format!(
                "{label} entry exceeds the safe {max_item_bytes} byte limit (actual: {})",
                trimmed.len()
            ));
        }
        let value = normalize_domain(value);
        if value.len() > max_item_bytes {
            return Err(format!(
                "{label} entry exceeds the safe {max_item_bytes} byte limit (actual: {})",
                value.len()
            ));
        }
        total_bytes = total_bytes.saturating_add(value.len());
        if total_bytes > max_total_bytes {
            return Err(format!(
                "{label} exceeds the safe {max_total_bytes} byte aggregate limit"
            ));
        }
    }
    Ok(())
}

fn validate_https_url(label: &'static str, value: &str) -> Result<(), String> {
    if value.len() > MAX_CUSTOM_URL_BYTES {
        return Err(format!(
            "{label} exceeds the safe {MAX_CUSTOM_URL_BYTES} byte limit (actual: {})",
            value.len()
        ));
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| format!("{label} is not a valid URL"))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(format!("{label} must use HTTPS and include a host"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("{label} must not contain embedded credentials"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_topology_request(
    hostnames: &[String],
    service_hosts: Option<&[String]>,
    doh_provider: Option<&str>,
    doh_custom_url: Option<&str>,
    resolver_mode: Option<&str>,
    dns_server: Option<&str>,
    custom_dns_server: Option<&str>,
    geo_provider: Option<&str>,
    tcp_service_ports: Option<&[u16]>,
) -> Result<(), String> {
    validate_text_collection(
        "topology hostnames",
        hostnames,
        MAX_TOPOLOGY_HOSTS,
        MAX_HOSTNAME_BYTES,
        MAX_TOPOLOGY_HOST_BYTES,
    )?;
    let services = service_hosts.unwrap_or_default();
    validate_text_collection(
        "service hosts",
        services,
        MAX_SERVICE_HOSTS,
        MAX_HOSTNAME_BYTES,
        MAX_SERVICE_HOSTS * MAX_HOSTNAME_BYTES,
    )?;
    let ports = tcp_service_ports.unwrap_or_default();
    if ports.len() > MAX_TCP_SERVICE_PORTS {
        return Err(format!(
            "TCP service port count exceeds the safe {MAX_TCP_SERVICE_PORTS} item limit (actual: {})",
            ports.len()
        ));
    }
    if ports.contains(&0) {
        return Err("TCP service ports must be greater than zero".to_string());
    }
    let work = services.len().saturating_mul(ports.len());
    if work > MAX_TCP_PROBE_PRODUCT {
        return Err(format!(
            "service host and port product exceeds the safe {MAX_TCP_PROBE_PRODUCT} probe limit (actual: {work})"
        ));
    }
    if let Some(url) = doh_custom_url.map(str::trim).filter(|url| !url.is_empty()) {
        validate_https_url("custom DoH URL", url)?;
    }
    for (label, value) in [
        ("DoH provider", doh_provider),
        ("resolver mode", resolver_mode),
        ("geolocation provider", geo_provider),
    ] {
        if value.is_some_and(|value| value.len() > MAX_SELECTOR_BYTES) {
            return Err(format!(
                "{label} exceeds the safe {MAX_SELECTOR_BYTES} byte limit"
            ));
        }
    }
    for (label, value) in [
        ("DNS server", dns_server),
        ("custom DNS server", custom_dns_server),
    ] {
        if let Some(value) = value {
            if value.len() > MAX_HOSTNAME_BYTES {
                return Err(format!(
                    "{label} exceeds the safe {MAX_HOSTNAME_BYTES} byte limit"
                ));
            }
        }
    }
    if !matches!(
        resolver_mode
            .unwrap_or("dns")
            .trim()
            .to_lowercase()
            .as_str(),
        "dns" | "doh"
    ) {
        return Err("resolver mode must be dns or doh".to_string());
    }
    if !matches!(
        geo_provider
            .unwrap_or("auto")
            .trim()
            .to_lowercase()
            .as_str(),
        "auto" | "internal" | "ipwhois" | "ipapi_co" | "ip_api"
    ) {
        return Err("geolocation provider is not supported".to_string());
    }
    Ok(())
}

/// Resolve a batch of hostnames with CNAME chain following, IP
/// geolocation, and HTTP/TCP service probing.
#[allow(clippy::too_many_arguments)]
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
) -> Result<TopologyBatchResult, String> {
    validate_topology_request(
        &hostnames,
        service_hosts.as_deref(),
        doh_provider.as_deref(),
        doh_custom_url.as_deref(),
        resolver_mode.as_deref(),
        dns_server.as_deref(),
        custom_dns_server.as_deref(),
        geo_provider.as_deref(),
        tcp_service_ports.as_deref(),
    )?;
    let _request_permit = topology_request_semaphore()
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            format!(
                "topology resolver is busy; at most {MAX_CONCURRENT_TOPOLOGY_REQUESTS} requests may run concurrently"
            )
        })?;
    let max_hops = usize::from(max_hops.unwrap_or(15)).clamp(1, 15);
    let lookup_timeout_ms = lookup_timeout_ms.unwrap_or(1200).clamp(250, 10000);
    let disable_ptr_lookups = disable_ptr_lookups.unwrap_or(false);
    let disable_geo_lookups = disable_geo_lookups.unwrap_or(false);
    let geo_provider = geo_provider
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_lowercase();
    let scan_resolution_chain = scan_resolution_chain.unwrap_or(true);
    let resolver_mode = resolver_mode
        .unwrap_or_else(|| "dns".to_string())
        .trim()
        .to_lowercase();
    let selected_dns_server = resolve_dns_server(
        dns_server.as_deref(),
        custom_dns_server.as_deref(),
        doh_provider.as_deref(),
    );
    let doh_endpoints = if resolver_mode == "doh" {
        resolve_doh_endpoints(
            Some(&selected_dns_server),
            custom_dns_server.as_deref(),
            doh_custom_url.as_deref(),
            doh_provider.as_deref(),
        )?
    } else {
        Vec::new()
    };
    let doh_provider_key = doh_provider
        .as_deref()
        .unwrap_or("cloudflare")
        .trim()
        .to_lowercase();
    let doh_custom_key = doh_custom_url.unwrap_or_default().trim().to_string();
    let resolver = build_dns_resolver(
        Some(&selected_dns_server),
        custom_dns_server.as_deref(),
        doh_provider.as_deref(),
    )?;
    let resolver_http_client = reqwest::Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;

    let mut seen_hosts = HashSet::new();
    let mut unique_hosts = Vec::new();
    for h in hostnames {
        let Some(normalized) = bounded_domain(&h) else {
            continue;
        };
        if !seen_hosts.insert(normalized.clone()) {
            continue;
        }
        unique_hosts.push(normalized);
    }

    let now_ms = Utc::now().timestamp_millis();
    let mut unresolved_hosts = Vec::new();
    let mut resolved_by_host: HashMap<String, HostnameChainResult> = HashMap::new();
    {
        let cache = topology_host_cache().read().await;
        for host in &unique_hosts {
            let cache_key = format!(
                "{}|{}|{}|{}|{}|{}|{}|{}|{}",
                resolver_mode,
                selected_dns_server,
                doh_provider_key,
                doh_custom_key,
                max_hops,
                disable_ptr_lookups,
                scan_resolution_chain,
                disable_geo_lookups,
                host
            );
            if let Some(entry) = cache.get(&cache_key) {
                if now_ms - entry.ts_ms <= TOPOLOGY_HOST_CACHE_TTL_MS {
                    resolved_by_host.insert(host.clone(), entry.value.clone());
                    continue;
                }
            }
            unresolved_hosts.push(host.clone());
        }
    }

    let mut cache_updates: Vec<(String, HostnameChainResult)> = Vec::new();
    let resolve_parallelism = NETWORK_CONCURRENCY;
    for chunk in unresolved_hosts.chunks(resolve_parallelism) {
        let mut set = tokio::task::JoinSet::new();
        for host in chunk {
            let host_owned = host.clone();
            let resolver_cloned = resolver.clone();
            let client_cloned = resolver_http_client.clone();
            let doh_endpoints_cloned = doh_endpoints.clone();
            set.spawn(async move {
                resolve_chain_for_host(
                    &resolver_cloned,
                    &client_cloned,
                    &doh_endpoints_cloned,
                    &host_owned,
                    max_hops,
                    scan_resolution_chain,
                    lookup_timeout_ms,
                    disable_ptr_lookups,
                )
                .await
            });
        }
        while let Some(joined) = set.join_next().await {
            if let Ok(result) = joined {
                let host = normalize_domain(&result.name);
                if !host.is_empty() {
                    resolved_by_host.insert(host.clone(), result.clone());
                    cache_updates.push((host, result));
                }
            }
        }
    }

    if !cache_updates.is_empty() {
        let write_ts = Utc::now().timestamp_millis();
        let mut cache = topology_host_cache().write().await;
        for (host, result) in cache_updates {
            let cache_key = format!(
                "{}|{}|{}|{}|{}|{}|{}|{}|{}",
                resolver_mode,
                selected_dns_server,
                doh_provider_key,
                doh_custom_key,
                max_hops,
                disable_ptr_lookups,
                scan_resolution_chain,
                disable_geo_lookups,
                host
            );
            cache.insert(
                cache_key,
                TopologyHostCacheEntry {
                    ts_ms: write_ts,
                    value: result,
                },
            );
        }
        cache.retain(|_, entry| write_ts - entry.ts_ms <= TOPOLOGY_HOST_CACHE_TTL_MS);
        if cache.len() > TOPOLOGY_HOST_CACHE_MAX_ENTRIES {
            let mut oldest: Vec<(String, i64)> =
                cache.iter().map(|(k, v)| (k.clone(), v.ts_ms)).collect();
            oldest.sort_by_key(|(_, ts)| *ts);
            let remove_count = cache.len() - TOPOLOGY_HOST_CACHE_MAX_ENTRIES;
            for (k, _) in oldest.into_iter().take(remove_count) {
                cache.remove(&k);
            }
        }
    }

    let mut resolutions = Vec::new();
    for host in unique_hosts {
        if let Some(value) = resolved_by_host.remove(&host) {
            resolutions.push(value);
        }
    }

    let geo_by_ip = if disable_geo_lookups {
        HashMap::new()
    } else {
        let mut ip_set = HashSet::new();
        let mut all_ips = Vec::new();
        for result in &resolutions {
            for ip in result.ipv4.iter().chain(result.ipv6.iter()) {
                if ip_set.insert(ip.clone()) {
                    if all_ips.len() >= MAX_BATCH_GEO_IPS {
                        return Err(format!(
                            "topology geolocation input exceeds the safe {MAX_BATCH_GEO_IPS} unique IP limit; disable geolocation or use a smaller batch"
                        ));
                    }
                    all_ips.push(ip.clone());
                }
            }
        }
        resolve_geo_for_ips(
            &resolver_http_client,
            &all_ips,
            lookup_timeout_ms,
            &geo_provider,
        )
        .await
    };
    if !disable_geo_lookups && !geo_by_ip.is_empty() {
        for result in &mut resolutions {
            let mut assigned = Vec::new();
            let mut seen = HashSet::new();
            for ip in result.ipv4.iter().chain(result.ipv6.iter()) {
                if !seen.insert(ip.clone()) {
                    continue;
                }
                if let Some(geo) = geo_by_ip.get(ip) {
                    assigned.push(geo.clone());
                }
            }
            result.geo_by_ip = assigned;
        }
    }

    let mut probes = Vec::new();
    let mut tcp_probes = Vec::new();
    let mut seen_probe_hosts = HashSet::new();
    let mut unique_probe_hosts = Vec::new();
    for host in service_hosts.unwrap_or_default() {
        let Some(normalized) = bounded_domain(&host) else {
            continue;
        };
        if !seen_probe_hosts.insert(normalized.clone()) {
            continue;
        }
        unique_probe_hosts.push(normalized);
    }

    let probe_parallelism = 8usize;
    for chunk in unique_probe_hosts.chunks(probe_parallelism) {
        let mut set = tokio::task::JoinSet::new();
        for host in chunk {
            let host_owned = host.clone();
            let client_cloned = resolver_http_client.clone();
            set.spawn(async move {
                let https_url = format!("https://{}", host_owned);
                let http_url = format!("http://{}", host_owned);
                let (https, http) = tokio::join!(
                    probe_url(&client_cloned, https_url),
                    probe_url(&client_cloned, http_url)
                );
                ServiceProbeResult {
                    host: host_owned,
                    https_up: https,
                    http_up: http,
                }
            });
        }
        while let Some(joined) = set.join_next().await {
            if let Ok(result) = joined {
                probes.push(result);
            }
        }
    }

    let tcp_ports: Vec<u16> = tcp_service_ports
        .unwrap_or_default()
        .into_iter()
        .filter(|p| *p > 0)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !tcp_ports.is_empty() && !unique_probe_hosts.is_empty() {
        for chunk in unique_probe_hosts.chunks(probe_parallelism) {
            let mut set = tokio::task::JoinSet::new();
            for host in chunk {
                let host_owned = host.clone();
                let ports = tcp_ports.clone();
                set.spawn(async move {
                    let mut out = Vec::new();
                    for port in ports {
                        let up = probe_tcp(&host_owned, port, lookup_timeout_ms).await;
                        out.push(TcpServiceProbeResult {
                            host: host_owned.clone(),
                            port,
                            up,
                        });
                    }
                    out
                });
            }
            while let Some(joined) = set.join_next().await {
                if let Ok(items) = joined {
                    tcp_probes.extend(items);
                }
            }
        }
    }

    Ok(TopologyBatchResult {
        resolutions,
        probes,
        tcp_probes,
    })
}

// ── DNS Propagation Checker ────────────────────────────────────────────────

/// Result of a propagation check against one resolver.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropagationResolverResult {
    pub resolver: String,
    pub resolver_label: String,
    pub answers: Vec<String>,
    pub rcode: String,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// Full propagation check result for a single query.
#[derive(Debug, Serialize, Deserialize)]
pub struct PropagationResult {
    pub domain: String,
    pub record_type: String,
    pub results: Vec<PropagationResolverResult>,
    pub consistent: bool,
    /// The agreement threshold (50..=100) that `consistent` was evaluated against.
    #[serde(default = "default_consensus_percent")]
    pub consensus_percent: u8,
    /// Number of successful resolvers that returned the majority answer set.
    #[serde(default)]
    pub agreeing: usize,
}

fn default_consensus_percent() -> u8 {
    DEFAULT_PROPAGATION_CONSENSUS_PERCENT
}

/// One well-known public resolver the propagation checker can query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PropagationResolverEntry {
    /// Stable identifier (currently identical to `ip`).
    pub id: &'static str,
    pub ip: &'static str,
    pub label: &'static str,
    pub provider: &'static str,
    pub region: &'static str,
    pub default_enabled: bool,
}

const fn entry(
    ip: &'static str,
    label: &'static str,
    provider: &'static str,
    region: &'static str,
    default_enabled: bool,
) -> PropagationResolverEntry {
    PropagationResolverEntry {
        id: ip,
        ip,
        label,
        provider,
        region,
        default_enabled,
    }
}

/// Well-known public resolvers to check propagation against.
///
/// This is the single source of truth; the TypeScript mirror in
/// `src/lib/dns/propagation-resolvers.ts` is parity-tested against this block.
// PROPAGATION_CATALOGUE_BEGIN
const PROPAGATION_RESOLVER_CATALOGUE: &[PropagationResolverEntry] = &[
    entry("1.1.1.1", "Cloudflare", "Cloudflare", "Global", true),
    entry(
        "1.0.0.1",
        "Cloudflare (secondary)",
        "Cloudflare",
        "Global",
        false,
    ),
    entry("8.8.8.8", "Google", "Google", "Global", true),
    entry("8.8.4.4", "Google (secondary)", "Google", "Global", false),
    entry("9.9.9.9", "Quad9", "Quad9", "Global", true),
    entry(
        "149.112.112.112",
        "Quad9 (secondary)",
        "Quad9",
        "Global",
        false,
    ),
    entry("208.67.222.222", "OpenDNS", "Cisco OpenDNS", "Global", true),
    entry(
        "208.67.220.220",
        "OpenDNS (secondary)",
        "Cisco OpenDNS",
        "Global",
        false,
    ),
    entry(
        "185.228.168.9",
        "CleanBrowsing",
        "CleanBrowsing",
        "Global",
        true,
    ),
    entry("76.76.19.19", "Alternate DNS", "Alternate DNS", "US", false),
    entry("94.140.14.14", "AdGuard", "AdGuard", "Global", true),
    entry("8.26.56.26", "Comodo", "Comodo Secure DNS", "US", true),
    entry("4.2.2.2", "Level3 / Lumen", "Lumen", "US", true),
    entry(
        "64.6.64.6",
        "Neustar UltraDNS",
        "Neustar / Vercara",
        "US",
        true,
    ),
    entry("84.200.69.80", "DNS.WATCH", "DNS.WATCH", "Germany", true),
    entry("77.88.8.8", "Yandex", "Yandex", "Russia", false),
    entry(
        "74.82.42.42",
        "Hurricane Electric",
        "Hurricane Electric",
        "US",
        true,
    ),
    entry("76.76.2.0", "Control D", "Control D", "Global", true),
    entry("45.90.28.0", "NextDNS", "NextDNS", "Global", false),
    entry(
        "156.154.70.1",
        "Neustar (secondary)",
        "Neustar / Vercara",
        "US",
        false,
    ),
    entry(
        "101.101.101.101",
        "Quad101 (TWNIC)",
        "TWNIC",
        "Taiwan",
        false,
    ),
    entry("114.114.114.114", "114DNS", "114DNS", "China", false),
    entry("80.80.80.80", "Freenom World", "Freenom", "Global", false),
];
// PROPAGATION_CATALOGUE_END

/// The full resolver catalogue, in display order.
pub fn propagation_resolver_catalogue() -> &'static [PropagationResolverEntry] {
    PROPAGATION_RESOLVER_CATALOGUE
}

/// Per-resolver query timeout when none is supplied (the historical fixed value).
pub const DEFAULT_PROPAGATION_TIMEOUT_MS: u32 = 3_000;
/// Retry count per resolver when none is supplied.
pub const DEFAULT_PROPAGATION_ATTEMPTS: u8 = 1;
/// Agreement threshold when none is supplied (historical rule: all must agree).
pub const DEFAULT_PROPAGATION_CONSENSUS_PERCENT: u8 = 100;

/// Optional tuning for a propagation check. Every field is optional and
/// falls back to the historical behaviour; numeric fields are clamped.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PropagationOptions {
    /// Catalogue ids to query. `None` selects every `default_enabled` entry.
    pub resolvers: Option<Vec<String>>,
    /// Per-attempt timeout, clamped to `MIN..=MAX_PROPAGATION_TIMEOUT_MS`.
    pub timeout_ms: Option<u32>,
    /// Attempts per resolver, clamped to `MIN..=MAX_PROPAGATION_ATTEMPTS`.
    pub attempts: Option<u8>,
    /// Percentage of successful resolvers that must agree, clamped to
    /// `MIN..=MAX_PROPAGATION_CONSENSUS_PERCENT`.
    pub consensus_percent: Option<u8>,
}

/// Fully resolved, clamped tuning derived from [`PropagationOptions`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedPropagationOptions {
    pub timeout: Duration,
    pub attempts: usize,
    pub consensus_percent: u8,
}

impl ResolvedPropagationOptions {
    /// Outer deadline for one resolver: every attempt may use the full
    /// timeout, plus a fixed grace period for connection setup.
    pub fn deadline(&self) -> Duration {
        self.timeout * (self.attempts as u32) + Duration::from_secs(2)
    }
}

/// Clamp the numeric knobs of `options` into their supported ranges.
pub fn clamp_propagation_options(options: &PropagationOptions) -> ResolvedPropagationOptions {
    let timeout_ms = options
        .timeout_ms
        .unwrap_or(DEFAULT_PROPAGATION_TIMEOUT_MS)
        .clamp(MIN_PROPAGATION_TIMEOUT_MS, MAX_PROPAGATION_TIMEOUT_MS);
    let attempts = options
        .attempts
        .unwrap_or(DEFAULT_PROPAGATION_ATTEMPTS)
        .clamp(MIN_PROPAGATION_ATTEMPTS, MAX_PROPAGATION_ATTEMPTS);
    let consensus_percent = options
        .consensus_percent
        .unwrap_or(DEFAULT_PROPAGATION_CONSENSUS_PERCENT)
        .clamp(
            MIN_PROPAGATION_CONSENSUS_PERCENT,
            MAX_PROPAGATION_CONSENSUS_PERCENT,
        );
    ResolvedPropagationOptions {
        timeout: Duration::from_millis(u64::from(timeout_ms)),
        attempts: usize::from(attempts),
        consensus_percent,
    }
}

/// Decide whether the successful results agree at `percent`.
///
/// Among results with no error and `NOERROR`, the most common answer set is
/// the majority; returns `(consistent, agreeing)` where `agreeing` is the
/// size of that majority. With no successful result nothing is consistent.
pub fn compute_consensus(results: &[PropagationResolverResult], percent: u8) -> (bool, usize) {
    // Answers are already deduplicated and sorted by `query_single_resolver`.
    let successful: Vec<&Vec<String>> = results
        .iter()
        .filter(|result| result.error.is_none() && result.rcode == "NOERROR")
        .map(|result| &result.answers)
        .collect();
    if successful.is_empty() {
        return (false, 0);
    }
    let mut counts: HashMap<&Vec<String>, usize> = HashMap::new();
    for answers in &successful {
        *counts.entry(answers).or_insert(0) += 1;
    }
    let agreeing = counts.values().copied().max().unwrap_or(0);
    let consistent = agreeing * 100 >= successful.len() * usize::from(percent);
    (consistent, agreeing)
}

struct ValidatedPropagationRequest {
    domain: String,
    record_type: String,
    resolvers: Vec<(String, String)>,
    options: ResolvedPropagationOptions,
}

fn validate_propagation_request(
    domain: &str,
    record_type: &str,
    extra_resolvers: Option<&[String]>,
    options: &PropagationOptions,
) -> Result<ValidatedPropagationRequest, String> {
    let domain = bounded_domain(domain)
        .ok_or_else(|| format!("domain must contain 1 to {MAX_HOSTNAME_BYTES} UTF-8 bytes"))?;
    let record_type = record_type.trim().to_uppercase();
    if record_type.is_empty()
        || record_type.len() > 16
        || !record_type
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("record type must be a short DNS record identifier".to_string());
    }

    let extras = extra_resolvers.unwrap_or_default();
    if extras.len() > MAX_EXTRA_RESOLVERS {
        return Err(format!(
            "extra resolver count exceeds the safe {MAX_EXTRA_RESOLVERS} item limit (actual: {})",
            extras.len()
        ));
    }

    let mut resolver_list: Vec<(String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    match options.resolvers.as_deref() {
        None => {
            for entry in PROPAGATION_RESOLVER_CATALOGUE
                .iter()
                .filter(|entry| entry.default_enabled)
            {
                seen.insert(entry.ip.to_string());
                resolver_list.push((entry.ip.to_string(), entry.label.to_string()));
            }
        }
        Some(ids) => {
            if ids.len() > MAX_PROPAGATION_RESOLVERS {
                return Err(format!(
                    "resolver selection exceeds the safe {MAX_PROPAGATION_RESOLVERS} item limit (actual: {})",
                    ids.len()
                ));
            }
            for id in ids {
                let id = id.trim();
                let entry = PROPAGATION_RESOLVER_CATALOGUE
                    .iter()
                    .find(|entry| entry.id == id)
                    .ok_or_else(|| {
                        format!("unknown propagation resolver id: {}", bounded_error(id))
                    })?;
                if seen.insert(entry.ip.to_string()) {
                    resolver_list.push((entry.ip.to_string(), entry.label.to_string()));
                }
            }
        }
    }
    for resolver in extras {
        let resolver = resolver.trim();
        if resolver.len() > MAX_IP_LITERAL_BYTES {
            return Err(format!(
                "extra resolver exceeds the safe {MAX_IP_LITERAL_BYTES} byte IP literal limit"
            ));
        }
        let parsed = resolver
            .parse::<IpAddr>()
            .map_err(|_| format!("extra resolver is not a valid IP address: {resolver}"))?;
        let normalized = parsed.to_string();
        if seen.insert(normalized.clone()) {
            resolver_list.push((normalized.clone(), format!("Custom ({normalized})")));
        }
    }
    if resolver_list.is_empty() {
        return Err("select at least one resolver".to_string());
    }
    if resolver_list.len() > MAX_PROPAGATION_RESOLVERS {
        return Err(format!(
            "resolver count exceeds the safe {MAX_PROPAGATION_RESOLVERS} item limit (actual: {})",
            resolver_list.len()
        ));
    }
    Ok(ValidatedPropagationRequest {
        domain,
        record_type,
        resolvers: resolver_list,
        options: clamp_propagation_options(options),
    })
}

/// Check DNS propagation across the default resolver set.
///
/// Thin wrapper over [`check_propagation_with_options`] using default options.
pub async fn check_propagation(
    domain: String,
    record_type: String,
    extra_resolvers: Option<Vec<String>>,
) -> Result<PropagationResult, String> {
    check_propagation_with_options(
        domain,
        record_type,
        extra_resolvers,
        PropagationOptions::default(),
    )
    .await
}

/// Check DNS propagation across the selected resolvers.
///
/// Queries the given domain for `record_type` against each selected public
/// DNS resolver plus any custom `extra_resolvers`, and reports whether the
/// successful answers agree at the configured consensus percentage.
pub async fn check_propagation_with_options(
    domain: String,
    record_type: String,
    extra_resolvers: Option<Vec<String>>,
    options: PropagationOptions,
) -> Result<PropagationResult, String> {
    let ValidatedPropagationRequest {
        domain,
        record_type,
        resolvers: resolver_list,
        options,
    } = validate_propagation_request(&domain, &record_type, extra_resolvers.as_deref(), &options)?;
    let _request_permit = propagation_request_semaphore()
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            format!(
                "propagation checker is busy; at most {MAX_CONCURRENT_PROPAGATION_REQUESTS} requests may run concurrently"
            )
        })?;
    let query_domain = domain.clone();
    let query_record_type = record_type.clone();
    let results = bounded_parallel_map(
        resolver_list,
        NETWORK_CONCURRENCY,
        move |(ip, label): (String, String)| {
            let domain = query_domain.clone();
            let record_type = query_record_type.clone();
            async move { query_single_resolver(&ip, &label, &domain, &record_type, options).await }
        },
    )
    .await;

    let (consistent, agreeing) = compute_consensus(&results, options.consensus_percent);

    Ok(PropagationResult {
        domain,
        record_type,
        results,
        consistent,
        consensus_percent: options.consensus_percent,
        agreeing,
    })
}

async fn query_single_resolver(
    ip: &str,
    label: &str,
    domain: &str,
    record_type: &str,
    options: ResolvedPropagationOptions,
) -> PropagationResolverResult {
    let start = std::time::Instant::now();
    let parsed_ip: IpAddr = match ip.parse() {
        Ok(ip) => ip,
        Err(e) => {
            return PropagationResolverResult {
                resolver: ip.to_string(),
                resolver_label: label.to_string(),
                answers: vec![],
                rcode: "SERVFAIL".to_string(),
                latency_ms: 0,
                error: Some(bounded_error(format!("Invalid IP: {}", e))),
            };
        }
    };

    let mut opts = ResolverOpts::default();
    opts.timeout = options.timeout;
    opts.attempts = options.attempts;
    let config =
        ResolverConfig::from_parts(None, vec![], vec![NameServerConfig::udp_and_tcp(parsed_ip)]);
    let resolver = match TokioResolver::builder_with_config(config, TokioRuntimeProvider::default())
        .with_options(opts)
        .build()
    {
        Ok(resolver) => resolver,
        Err(error) => {
            return PropagationResolverResult {
                resolver: ip.to_string(),
                resolver_label: label.to_string(),
                answers: vec![],
                rcode: "SERVFAIL".to_string(),
                latency_ms: 0,
                error: Some(error.to_string()),
            };
        }
    };

    note_network_start();
    let timeout_result = tokio::time::timeout(options.deadline(), async {
        match record_type.to_uppercase().as_str() {
            "A" => {
                let lookup = resolver.ipv4_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .answers()
                            .iter()
                            .filter_map(|record| match &record.data {
                                RData::A(address) => Some(address.to_string()),
                                _ => None,
                            })
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (
                        vec![],
                        error_to_rcode(&e),
                        Some(bounded_error(e.to_string())),
                    ),
                }
            }
            "AAAA" => {
                let lookup = resolver.ipv6_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .answers()
                            .iter()
                            .filter_map(|record| match &record.data {
                                RData::AAAA(address) => Some(address.to_string()),
                                _ => None,
                            })
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (
                        vec![],
                        error_to_rcode(&e),
                        Some(bounded_error(e.to_string())),
                    ),
                }
            }
            "MX" => {
                let lookup = resolver.mx_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .answers()
                            .iter()
                            .filter_map(|record| match &record.data {
                                RData::MX(mx) => Some(format!(
                                    "{} {}",
                                    mx.preference,
                                    normalize_domain(&mx.exchange.to_string())
                                )),
                                _ => None,
                            })
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (
                        vec![],
                        error_to_rcode(&e),
                        Some(bounded_error(e.to_string())),
                    ),
                }
            }
            "TXT" => {
                let lookup = resolver.txt_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .answers()
                            .iter()
                            .filter_map(|record| match &record.data {
                                RData::TXT(txt) => Some(txt.to_string()),
                                _ => None,
                            })
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (
                        vec![],
                        error_to_rcode(&e),
                        Some(bounded_error(e.to_string())),
                    ),
                }
            }
            "NS" => {
                let lookup = resolver.ns_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .answers()
                            .iter()
                            .filter_map(|record| match &record.data {
                                RData::NS(ns) => Some(normalize_domain(&ns.to_string())),
                                _ => None,
                            })
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (
                        vec![],
                        error_to_rcode(&e),
                        Some(bounded_error(e.to_string())),
                    ),
                }
            }
            "CNAME" => {
                let lookup = resolver.lookup(domain, RecordType::CNAME).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .answers()
                            .iter()
                            .filter_map(|record| match &record.data {
                                RData::CNAME(cname) => Some(normalize_domain(&cname.to_string())),
                                _ => None,
                            })
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (
                        vec![],
                        error_to_rcode(&e),
                        Some(bounded_error(e.to_string())),
                    ),
                }
            }
            _ => {
                // Generic lookup
                let lookup = resolver.lookup(domain, RecordType::Unknown(0)).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .answers()
                            .iter()
                            .map(|record| record.data.to_string())
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (
                        vec![],
                        error_to_rcode(&e),
                        Some(bounded_error(e.to_string())),
                    ),
                }
            }
        }
    })
    .await;

    let elapsed = start.elapsed().as_millis() as u64;

    match timeout_result {
        Ok((answers, rcode, error)) => match bounded_answers(answers) {
            Ok(answers) => PropagationResolverResult {
                resolver: ip.to_string(),
                resolver_label: label.to_string(),
                answers,
                rcode,
                latency_ms: elapsed,
                error,
            },
            Err(error) => PropagationResolverResult {
                resolver: ip.to_string(),
                resolver_label: label.to_string(),
                answers: Vec::new(),
                rcode: "SERVFAIL".to_string(),
                latency_ms: elapsed,
                error: Some(error),
            },
        },
        Err(_) => PropagationResolverResult {
            resolver: ip.to_string(),
            resolver_label: label.to_string(),
            answers: vec![],
            rcode: "TIMEOUT".to_string(),
            latency_ms: elapsed,
            error: Some("Query timed out".to_string()),
        },
    }
}

fn error_to_rcode(err: &hickory_resolver::net::NetError) -> String {
    let s = err.to_string().to_lowercase();
    if s.contains("nxdomain") || s.contains("no records") || s.contains("no connections") {
        "NXDOMAIN".to_string()
    } else if s.contains("refused") {
        "REFUSED".to_string()
    } else if s.contains("timeout") || s.contains("timed out") {
        "TIMEOUT".to_string()
    } else {
        "SERVFAIL".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn normalize_domain_works() {
        assert_eq!(normalize_domain("Example.COM."), "example.com");
        assert_eq!(normalize_domain("  test.dev  "), "test.dev");
    }

    #[test]
    fn internal_geo_loopback() {
        let geo = resolve_internal_ip_geo("127.0.0.1").unwrap();
        assert_eq!(geo.country, "Loopback");
    }

    #[test]
    fn internal_geo_private() {
        let geo = resolve_internal_ip_geo("192.168.1.1").unwrap();
        assert_eq!(geo.country, "Private/Reserved");
    }

    #[test]
    fn internal_geo_public_returns_none() {
        assert!(resolve_internal_ip_geo("1.1.1.1").is_none());
    }

    #[test]
    fn dns_server_resolution() {
        assert_eq!(resolve_dns_server(None, None, None), "1.1.1.1");
        assert_eq!(resolve_dns_server(Some("8.8.8.8"), None, None), "8.8.8.8");
        assert_eq!(
            resolve_dns_server(Some("custom"), Some("9.9.9.9"), None),
            "9.9.9.9"
        );
    }

    #[test]
    fn topology_host_count_accepts_limit_minus_one_and_exact_but_rejects_plus_one() {
        for count in [MAX_TOPOLOGY_HOSTS - 1, MAX_TOPOLOGY_HOSTS] {
            let hostnames = vec!["a.example".to_string(); count];
            assert!(validate_topology_request(
                &hostnames, None, None, None, None, None, None, None, None,
            )
            .is_ok());
        }
        let hostnames = vec!["a.example".to_string(); MAX_TOPOLOGY_HOSTS + 1];
        assert!(validate_topology_request(
            &hostnames, None, None, None, None, None, None, None, None,
        )
        .is_err());

        let aggregate_exact = vec!["a".repeat(MAX_HOSTNAME_BYTES); MAX_TOPOLOGY_HOSTS];
        assert!(validate_topology_request(
            &aggregate_exact,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .is_ok());
        assert!(validate_topology_request(
            &["a".repeat(MAX_HOSTNAME_BYTES + 1)],
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn custom_https_url_accepts_exact_limit_and_rejects_plus_one_or_cleartext() {
        let prefix = "https://example.com/";
        let exact = format!(
            "{}{}",
            prefix,
            "a".repeat(MAX_CUSTOM_URL_BYTES - prefix.len())
        );
        assert_eq!(exact.len(), MAX_CUSTOM_URL_BYTES);
        assert!(validate_https_url("custom DoH URL", &exact).is_ok());
        assert!(validate_https_url("custom DoH URL", &(exact + "a")).is_err());
        assert!(validate_https_url("custom DoH URL", "http://example.com/dns-query").is_err());
    }

    #[test]
    fn service_and_port_limits_accept_exact_product_and_reject_plus_one_vectors() {
        let services = vec!["service.example".to_string(); MAX_SERVICE_HOSTS];
        let ports: Vec<u16> = (1..=MAX_TCP_SERVICE_PORTS as u16).collect();
        assert!(validate_topology_request(
            &[],
            Some(&services),
            None,
            None,
            None,
            None,
            None,
            None,
            Some(&ports),
        )
        .is_ok());

        let too_many_services = vec!["service.example".to_string(); MAX_SERVICE_HOSTS + 1];
        assert!(validate_topology_request(
            &[],
            Some(&too_many_services),
            None,
            None,
            None,
            None,
            None,
            None,
            Some(&ports),
        )
        .is_err());
        let too_many_ports: Vec<u16> = (1..=(MAX_TCP_SERVICE_PORTS + 1) as u16).collect();
        assert!(validate_topology_request(
            &[],
            Some(&services),
            None,
            None,
            None,
            None,
            None,
            None,
            Some(&too_many_ports),
        )
        .is_err());
    }

    #[test]
    fn extra_resolver_limit_is_exact_and_all_entries_are_validated_before_work() {
        let exact: Vec<String> = (1..=MAX_EXTRA_RESOLVERS)
            .map(|index| format!("192.0.2.{index}"))
            .collect();
        let defaults = PropagationOptions::default();
        let validated =
            validate_propagation_request("example.com", "A", Some(&exact), &defaults).unwrap();
        assert_eq!(
            validated.resolvers.len(),
            default_propagation_resolver_count() + MAX_EXTRA_RESOLVERS
        );
        let mut oversized = exact;
        oversized.push("198.51.100.1".to_string());
        assert!(
            validate_propagation_request("example.com", "A", Some(&oversized), &defaults).is_err()
        );
        assert!(validate_propagation_request(
            "example.com",
            "A",
            Some(&["not-an-ip".to_string()]),
            &defaults
        )
        .is_err());
    }

    #[test]
    fn answer_limits_deduplicate_and_reject_adversarial_payloads() {
        let exact: Vec<String> = (0..MAX_DNS_ANSWERS)
            .map(|index| format!("answer-{index}.example"))
            .collect();
        assert_eq!(
            bounded_answers(exact.clone()).unwrap().len(),
            MAX_DNS_ANSWERS
        );
        let mut oversized = exact;
        oversized.push("one-too-many.example".to_string());
        assert!(bounded_answers(oversized).is_err());
        assert!(bounded_answers(["x".repeat(MAX_DNS_ANSWER_BYTES + 1)]).is_err());
        assert_eq!(
            bounded_answers(["same".to_string(), "same".to_string()])
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invalid_topology_request_starts_zero_network_work() {
        TEST_NETWORK_STARTS.store(0, Ordering::SeqCst);
        let hostnames = vec!["a.example".to_string(); MAX_TOPOLOGY_HOSTS + 1];
        let result = resolve_topology_batch(
            hostnames, None, None, None, None, None, None, None, None, None, None, None, None, None,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(TEST_NETWORK_STARTS.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invalid_propagation_request_starts_zero_network_work() {
        TEST_NETWORK_STARTS.store(0, Ordering::SeqCst);
        let extras = vec!["192.0.2.1".to_string(); MAX_EXTRA_RESOLVERS + 1];
        let result =
            check_propagation("example.com".to_string(), "A".to_string(), Some(extras)).await;
        assert!(result.is_err());
        assert_eq!(TEST_NETWORK_STARTS.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn aggregate_request_concurrency_is_bounded_before_network_work() {
        TEST_NETWORK_STARTS.store(0, Ordering::SeqCst);
        let topology_permits: Vec<_> = (0..MAX_CONCURRENT_TOPOLOGY_REQUESTS)
            .map(|_| {
                topology_request_semaphore()
                    .clone()
                    .try_acquire_owned()
                    .expect("reserve topology permit")
            })
            .collect();
        let topology = resolve_topology_batch(
            Vec::new(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(
            topology.is_err(),
            "topology request exceeded the global cap"
        );
        drop(topology_permits);

        let propagation_permits: Vec<_> = (0..MAX_CONCURRENT_PROPAGATION_REQUESTS)
            .map(|_| {
                propagation_request_semaphore()
                    .clone()
                    .try_acquire_owned()
                    .expect("reserve propagation permit")
            })
            .collect();
        let propagation = check_propagation("example.com".to_string(), "A".to_string(), None).await;
        assert!(
            propagation.is_err(),
            "propagation request exceeded the global cap"
        );
        drop(propagation_permits);
        assert_eq!(TEST_NETWORK_STARTS.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bounded_parallel_map_never_exceeds_network_concurrency() {
        let current = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let current_for_operation = current.clone();
        let peak_for_operation = peak.clone();
        let output =
            bounded_parallel_map((0usize..100).collect(), NETWORK_CONCURRENCY, move |value| {
                let current = current_for_operation.clone();
                let peak = peak_for_operation.clone();
                async move {
                    let active = current.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(active, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    current.fetch_sub(1, Ordering::SeqCst);
                    value
                }
            })
            .await;
        assert_eq!(output, (0usize..100).collect::<Vec<_>>());
        assert!(peak.load(Ordering::SeqCst) <= NETWORK_CONCURRENCY);
        assert!(peak.load(Ordering::SeqCst) > 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn oversized_http_body_is_rejected_from_content_length() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_DOH_RESPONSE_BYTES + 1
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        let parsed = read_json_limited::<DnsGoogleResponse>(
            response,
            MAX_DOH_RESPONSE_BYTES,
            Duration::from_secs(1),
        )
        .await;
        assert!(parsed.is_none());
        server.await.unwrap();
    }

    #[test]
    fn custom_resolver_preserves_timeout_and_attempt_limits() {
        let resolver =
            build_dns_resolver(Some("1.1.1.1"), None, None).expect("build custom DNS resolver");
        assert_eq!(resolver.options().timeout, Duration::from_secs(2));
        assert_eq!(resolver.options().attempts, 1);
    }

    fn default_propagation_resolver_count() -> usize {
        PROPAGATION_RESOLVER_CATALOGUE
            .iter()
            .filter(|entry| entry.default_enabled)
            .count()
    }

    fn synthetic_result(
        resolver: &str,
        answers: &[&str],
        rcode: &str,
    ) -> PropagationResolverResult {
        let mut answers: Vec<String> = answers.iter().map(|value| value.to_string()).collect();
        answers.sort();
        PropagationResolverResult {
            resolver: resolver.to_string(),
            resolver_label: resolver.to_string(),
            answers,
            rcode: rcode.to_string(),
            latency_ms: 1,
            error: if rcode == "NOERROR" {
                None
            } else {
                Some("failed".to_string())
            },
        }
    }

    #[test]
    fn propagation_catalogue_has_unique_ids_valid_ips_and_expected_defaults() {
        let catalogue = propagation_resolver_catalogue();
        assert_eq!(catalogue.len(), 23);
        let mut ids = HashSet::new();
        for entry in catalogue {
            assert!(ids.insert(entry.id), "duplicate id {}", entry.id);
            assert_eq!(entry.id, entry.ip);
            assert!(
                entry.ip.parse::<IpAddr>().is_ok(),
                "invalid ip {}",
                entry.ip
            );
            assert!(!entry.label.is_empty() && !entry.provider.is_empty());
            assert!(!entry.region.is_empty());
        }
        assert_eq!(default_propagation_resolver_count(), 12);
        assert!(default_propagation_resolver_count() <= MAX_PROPAGATION_RESOLVERS);
        for original in [
            "1.1.1.1",
            "8.8.8.8",
            "9.9.9.9",
            "208.67.222.222",
            "185.228.168.9",
            "94.140.14.14",
            "8.26.56.26",
        ] {
            assert!(
                catalogue
                    .iter()
                    .any(|entry| entry.id == original && entry.default_enabled),
                "{original} must stay default-enabled"
            );
        }
    }

    #[test]
    fn propagation_options_clamp_into_supported_ranges_and_default_to_legacy_behaviour() {
        let defaults = clamp_propagation_options(&PropagationOptions::default());
        assert_eq!(defaults.timeout, Duration::from_secs(3));
        assert_eq!(defaults.attempts, 1);
        assert_eq!(defaults.consensus_percent, 100);
        assert_eq!(defaults.deadline(), Duration::from_secs(5));

        let low = clamp_propagation_options(&PropagationOptions {
            resolvers: None,
            timeout_ms: Some(1),
            attempts: Some(0),
            consensus_percent: Some(3),
        });
        assert_eq!(low.timeout, Duration::from_millis(500));
        assert_eq!(low.attempts, 1);
        assert_eq!(low.consensus_percent, 50);

        let high = clamp_propagation_options(&PropagationOptions {
            resolvers: None,
            timeout_ms: Some(u32::MAX),
            attempts: Some(u8::MAX),
            consensus_percent: Some(u8::MAX),
        });
        assert_eq!(high.timeout, Duration::from_millis(15_000));
        assert_eq!(high.attempts, 3);
        assert_eq!(high.consensus_percent, 100);
        assert_eq!(high.deadline(), Duration::from_millis(47_000));
    }

    #[test]
    fn propagation_options_deserialize_camel_case_with_missing_fields() {
        let parsed: PropagationOptions =
            serde_json::from_str(r#"{"timeoutMs": 1200, "consensusPercent": 75}"#).unwrap();
        assert_eq!(parsed.timeout_ms, Some(1200));
        assert_eq!(parsed.consensus_percent, Some(75));
        assert_eq!(parsed.attempts, None);
        assert_eq!(parsed.resolvers, None);
        let empty: PropagationOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, PropagationOptions::default());
    }

    #[test]
    fn consensus_percentage_controls_consistency() {
        let results = vec![
            synthetic_result("a", &["192.0.2.1"], "NOERROR"),
            synthetic_result("b", &["192.0.2.1"], "NOERROR"),
            synthetic_result("c", &["192.0.2.1"], "NOERROR"),
            synthetic_result("d", &["192.0.2.9"], "NOERROR"),
            synthetic_result("e", &[], "TIMEOUT"),
        ];
        assert_eq!(compute_consensus(&results, 100), (false, 3));
        assert_eq!(compute_consensus(&results, 75), (true, 3));
        assert_eq!(compute_consensus(&results, 50), (true, 3));
        assert_eq!(compute_consensus(&[], 50), (false, 0));
        let failures = vec![synthetic_result("e", &[], "SERVFAIL")];
        assert_eq!(compute_consensus(&failures, 50), (false, 0));
        let unanimous = vec![
            synthetic_result("a", &["x", "y"], "NOERROR"),
            synthetic_result("b", &["y", "x"], "NOERROR"),
        ];
        assert_eq!(compute_consensus(&unanimous, 100), (true, 2));
    }

    #[test]
    fn resolver_selection_validates_ids_and_rejects_empty_selection() {
        let selected = PropagationOptions {
            resolvers: Some(vec![
                "8.8.8.8".to_string(),
                "1.1.1.1".to_string(),
                " 8.8.8.8 ".to_string(),
            ]),
            ..PropagationOptions::default()
        };
        let validated = validate_propagation_request("example.com", "A", None, &selected).unwrap();
        assert_eq!(validated.resolvers.len(), 2);
        assert_eq!(validated.resolvers[0].0, "8.8.8.8");
        assert_eq!(validated.resolvers[0].1, "Google");

        let unknown = PropagationOptions {
            resolvers: Some(vec!["203.0.113.7".to_string()]),
            ..PropagationOptions::default()
        };
        assert!(validate_propagation_request("example.com", "A", None, &unknown).is_err());

        let empty = PropagationOptions {
            resolvers: Some(Vec::new()),
            ..PropagationOptions::default()
        };
        assert!(validate_propagation_request("example.com", "A", None, &empty).is_err());
        let with_custom = validate_propagation_request(
            "example.com",
            "A",
            Some(&["192.0.2.1".to_string()]),
            &empty,
        )
        .unwrap();
        assert_eq!(with_custom.resolvers.len(), 1);

        let too_many = PropagationOptions {
            resolvers: Some(vec!["1.1.1.1".to_string(); MAX_PROPAGATION_RESOLVERS + 1]),
            ..PropagationOptions::default()
        };
        assert!(validate_propagation_request("example.com", "A", None, &too_many).is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unknown_resolver_id_starts_zero_network_work() {
        TEST_NETWORK_STARTS.store(0, Ordering::SeqCst);
        let options = PropagationOptions {
            resolvers: Some(vec!["not-a-catalogue-id".to_string()]),
            ..PropagationOptions::default()
        };
        let result = check_propagation_with_options(
            "example.com".to_string(),
            "A".to_string(),
            None,
            options,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(TEST_NETWORK_STARTS.load(Ordering::SeqCst), 0);
    }
}
