//! DNS topology resolution engine.
//!
//! Resolves hostname CNAME chains, IPv4/IPv6 addresses, PTR reverse
//! lookups, IP geolocation (multiple providers), and HTTP/TCP service
//! probing. Includes an in-process cache with configurable TTL.

use chrono::Utc;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::RwLock;
use trust_dns_resolver::config::{NameServerConfigGroup, ResolverConfig, ResolverOpts};
use trust_dns_resolver::TokioAsyncResolver;

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

// ─── Helpers ───────────────────────────────────────────────────────────────

fn normalize_domain(input: &str) -> String {
    input.trim().trim_end_matches('.').to_lowercase()
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
        let Ok(payload) = tokio::time::timeout(
            Duration::from_millis(u64::from(lookup_timeout_ms)),
            resp.json::<DnsGoogleResponse>(),
        )
        .await
        else {
            return None;
        };
        let Ok(payload) = payload else { return None };
        let mut out = Vec::new();
        for ans in payload.answer.unwrap_or_default() {
            let raw = ans.data.unwrap_or_default().trim().to_string();
            if raw.is_empty() {
                continue;
            }
            let value = if record_type == "CNAME" {
                normalize_domain(&raw)
            } else {
                raw
            };
            if !value.is_empty() && !out.contains(&value) {
                out.push(value);
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
        None
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

async fn resolve_chain_for_host(
    resolver: &TokioAsyncResolver,
    client: &reqwest::Client,
    doh_endpoints: &[String],
    host: &str,
    max_hops: usize,
    scan_resolution_chain: bool,
    lookup_timeout_ms: u32,
    disable_ptr_lookups: bool,
) -> HostnameChainResult {
    let name = normalize_domain(host);
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
            let cname_lookup = tokio::time::timeout(
                Duration::from_millis(u64::from(lookup_timeout_ms)),
                resolver.lookup(
                    cur.clone(),
                    trust_dns_resolver::proto::rr::RecordType::CNAME,
                ),
            )
            .await;
            let direct_next = match cname_lookup {
                Ok(Ok(lookup)) => lookup
                    .iter()
                    .next()
                    .map(|r| normalize_domain(&r.to_string()))
                    .filter(|s| !s.is_empty()),
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
        tokio::time::timeout(
            Duration::from_millis(u64::from(lookup_timeout_ms)),
            resolver.ipv4_lookup(cur.clone())
        ),
        tokio::time::timeout(
            Duration::from_millis(u64::from(lookup_timeout_ms)),
            resolver.ipv6_lookup(cur.clone())
        )
    );

    let mut ipv4 = Vec::new();
    if let Ok(Ok(v4)) = v4_lookup {
        for ip in v4.iter() {
            let v = ip.to_string();
            if !ipv4.contains(&v) {
                ipv4.push(v);
            }
        }
    }

    let mut ipv6 = Vec::new();
    if let Ok(Ok(v6)) = v6_lookup {
        for ip in v6.iter() {
            let v = ip.to_string();
            if !ipv6.contains(&v) {
                ipv6.push(v);
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
        }
        if ipv6.is_empty() {
            ipv6 = doh_v6;
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
            let ptr_lookup = tokio::time::timeout(
                Duration::from_millis(u64::from(lookup_timeout_ms)),
                resolver.reverse_lookup(parsed),
            )
            .await;
            if let Ok(Ok(ptr_lookup)) = ptr_lookup {
                for name in ptr_lookup.iter() {
                    let host = normalize_domain(&name.to_utf8());
                    if !host.is_empty() && !names.contains(&host) {
                        names.push(host);
                    }
                }
            }
            if !names.is_empty() {
                reverse_hostnames.push(ReverseHostnameResult { ip, hostnames: names });
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
        error: if unresolved {
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
    let Ok(payload) = tokio::time::timeout(
        Duration::from_millis(u64::from(lookup_timeout_ms).saturating_mul(2)),
        resp.json::<IpWhoisResponse>(),
    )
    .await
    else {
        return None;
    };
    let Ok(payload) = payload else { return None };
    if payload.success == Some(false) {
        return None;
    }
    let country = payload.country.unwrap_or_default().trim().to_string();
    if country.is_empty() {
        return None;
    }
    let country_code = payload
        .country_code
        .map(|value| value.trim().to_uppercase())
        .filter(|value| !value.is_empty());
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
    let Ok(payload) = tokio::time::timeout(
        Duration::from_millis(u64::from(lookup_timeout_ms).saturating_mul(2)),
        resp.json::<IpApiCoResponse>(),
    )
    .await
    else {
        return None;
    };
    let Ok(payload) = payload else { return None };
    if payload.error == Some(true) {
        return None;
    }
    let country = payload.country_name.unwrap_or_default().trim().to_string();
    if country.is_empty() {
        return None;
    }
    let country_code = payload
        .country_code
        .map(|value| value.trim().to_uppercase())
        .filter(|value| !value.is_empty());
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
        "http://ip-api.com/json/{}?fields=status,country,countryCode",
        ip
    );
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
    let Ok(payload) = tokio::time::timeout(
        Duration::from_millis(u64::from(lookup_timeout_ms).saturating_mul(2)),
        resp.json::<IpApiComResponse>(),
    )
    .await
    else {
        return None;
    };
    let Ok(payload) = payload else { return None };
    if payload.status.unwrap_or_default().to_lowercase() != "success" {
        return None;
    }
    let country = payload.country.unwrap_or_default().trim().to_string();
    if country.is_empty() {
        return None;
    }
    let country_code = payload
        .country_code
        .map(|value| value.trim().to_uppercase())
        .filter(|value| !value.is_empty());
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
        let mut set = tokio::task::JoinSet::new();
        for ip in unresolved {
            let ip_owned = ip.clone();
            let client_cloned = client.clone();
            let geo_provider_owned = geo_provider.to_string();
            set.spawn(async move {
                (
                    ip_owned.clone(),
                    fetch_ip_geo(&client_cloned, &ip_owned, lookup_timeout_ms, &geo_provider_owned)
                        .await,
                )
            });
        }
        let write_ts = Utc::now().timestamp_millis();
        let mut cache_updates: Vec<(String, Option<IpGeoResult>)> = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok((ip, maybe_geo)) = joined {
                if let Some(geo) = &maybe_geo {
                    out.insert(ip.clone(), geo.clone());
                }
                cache_updates.push((ip, maybe_geo));
            }
        }
        if !cache_updates.is_empty() {
            let mut cache = topology_ip_geo_cache().write().await;
            for (ip, value) in cache_updates {
                let key = format!("{}|{}", geo_provider, ip);
                cache.insert(key, TopologyIpGeoCacheEntry { ts_ms: write_ts, value });
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
    let fut = client.get(url).send();
    let resp = tokio::time::timeout(Duration::from_secs(5), fut).await;
    matches!(resp, Ok(Ok(_)))
}

async fn probe_tcp(host: &str, port: u16, timeout_ms: u32) -> bool {
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
) -> Result<TokioAsyncResolver, String> {
    let target = resolve_dns_server(dns_server, custom_dns_server, legacy_provider);
    if let Ok(ip) = target.parse() {
        let mut opts = ResolverOpts::default();
        opts.timeout = Duration::from_secs(2);
        opts.attempts = 1;
        let group = NameServerConfigGroup::from_ips_clear(&[ip], 53, true);
        return Ok(TokioAsyncResolver::tokio(
            ResolverConfig::from_parts(None, vec![], group),
            opts,
        ));
    }
    match TokioAsyncResolver::tokio_from_system_conf() {
        Ok(resolver) => Ok(resolver),
        Err(_) => Ok(TokioAsyncResolver::tokio(
            ResolverConfig::cloudflare(),
            ResolverOpts::default(),
        )),
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
) -> Vec<String> {
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
    out
}

// ─── Main batch resolver ──────────────────────────────────────────────────

/// Resolve a batch of hostnames with CNAME chain following, IP
/// geolocation, and HTTP/TCP service probing.
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
        )
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
        .redirect(Policy::limited(4))
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;

    let mut seen_hosts = HashSet::new();
    let mut unique_hosts = Vec::new();
    for h in hostnames {
        let normalized = normalize_domain(&h);
        if normalized.is_empty() || !seen_hosts.insert(normalized.clone()) {
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
    let resolve_parallelism = 16usize;
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

    let mut ip_set = HashSet::new();
    let mut all_ips = Vec::new();
    for result in &resolutions {
        for ip in result.ipv4.iter().chain(result.ipv6.iter()) {
            if ip_set.insert(ip.clone()) {
                all_ips.push(ip.clone());
            }
        }
    }

    let geo_by_ip = if disable_geo_lookups {
        HashMap::new()
    } else {
        resolve_geo_for_ips(&resolver_http_client, &all_ips, lookup_timeout_ms, &geo_provider)
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
        let normalized = normalize_domain(&host);
        if normalized.is_empty() || !seen_probe_hosts.insert(normalized.clone()) {
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
}

/// Well-known public resolvers to check propagation against.
const PROPAGATION_RESOLVERS: &[(&str, &str)] = &[
    ("1.1.1.1", "Cloudflare"),
    ("8.8.8.8", "Google"),
    ("9.9.9.9", "Quad9"),
    ("208.67.222.222", "OpenDNS"),
    ("185.228.168.9", "CleanBrowsing"),
    ("76.76.19.19", "Alternate DNS"),
    ("94.140.14.14", "AdGuard"),
    ("8.26.56.26", "Comodo"),
];

/// Check DNS propagation across multiple global resolvers.
///
/// Queries the given domain for `record_type` against each well-known
/// public DNS resolver and reports whether results are consistent.
pub async fn check_propagation(
    domain: String,
    record_type: String,
    extra_resolvers: Option<Vec<String>>,
) -> Result<PropagationResult, String> {
    let domain = normalize_domain(&domain);
    let mut resolver_list: Vec<(String, String)> = PROPAGATION_RESOLVERS
        .iter()
        .map(|(ip, label)| (ip.to_string(), label.to_string()))
        .collect();

    if let Some(extras) = extra_resolvers {
        for ip in extras {
            let ip = ip.trim().to_string();
            if !ip.is_empty() && !resolver_list.iter().any(|(r, _)| r == &ip) {
                let label = format!("Custom ({})", ip);
                resolver_list.push((ip, label));
            }
        }
    }

    let mut handles = Vec::new();
    for (ip, label) in &resolver_list {
        let ip = ip.clone();
        let label = label.clone();
        let domain = domain.clone();
        let record_type = record_type.clone();
        handles.push(tokio::spawn(async move {
            query_single_resolver(&ip, &label, &domain, &record_type).await
        }));
    }

    let mut results = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(r) => results.push(r),
            Err(e) => results.push(PropagationResolverResult {
                resolver: "unknown".to_string(),
                resolver_label: "unknown".to_string(),
                answers: vec![],
                rcode: "SERVFAIL".to_string(),
                latency_ms: 0,
                error: Some(e.to_string()),
            }),
        }
    }

    // Check consistency: all non-error resolvers should have same sorted answers
    let good_answers: Vec<Vec<String>> = results
        .iter()
        .filter(|r| r.error.is_none() && r.rcode == "NOERROR")
        .map(|r| {
            let mut a = r.answers.clone();
            a.sort();
            a
        })
        .collect();

    let consistent = if good_answers.is_empty() {
        false
    } else {
        good_answers.windows(2).all(|w| w[0] == w[1])
    };

    Ok(PropagationResult {
        domain,
        record_type,
        results,
        consistent,
    })
}

async fn query_single_resolver(
    ip: &str,
    label: &str,
    domain: &str,
    record_type: &str,
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
                error: Some(format!("Invalid IP: {}", e)),
            };
        }
    };

    let mut opts = ResolverOpts::default();
    opts.timeout = Duration::from_secs(3);
    opts.attempts = 1;
    let group = NameServerConfigGroup::from_ips_clear(&[parsed_ip], 53, true);
    let resolver = TokioAsyncResolver::tokio(
        ResolverConfig::from_parts(None, vec![], group),
        opts,
    );

    let timeout_result = tokio::time::timeout(Duration::from_secs(5), async {
        match record_type.to_uppercase().as_str() {
            "A" => {
                let lookup = resolver.ipv4_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l.iter().map(|a| a.to_string()).collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (vec![], error_to_rcode(&e), Some(e.to_string())),
                }
            }
            "AAAA" => {
                let lookup = resolver.ipv6_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l.iter().map(|a| a.to_string()).collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (vec![], error_to_rcode(&e), Some(e.to_string())),
                }
            }
            "MX" => {
                let lookup = resolver.mx_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .iter()
                            .map(|mx| {
                                format!(
                                    "{} {}",
                                    mx.preference(),
                                    normalize_domain(&mx.exchange().to_string())
                                )
                            })
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (vec![], error_to_rcode(&e), Some(e.to_string())),
                }
            }
            "TXT" => {
                let lookup = resolver.txt_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .iter()
                            .map(|txt| txt.to_string())
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (vec![], error_to_rcode(&e), Some(e.to_string())),
                }
            }
            "NS" => {
                let lookup = resolver.ns_lookup(domain).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .iter()
                            .map(|ns| normalize_domain(&ns.to_string()))
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (vec![], error_to_rcode(&e), Some(e.to_string())),
                }
            }
            "CNAME" => {
                let lookup = resolver.lookup(
                    domain,
                    trust_dns_resolver::proto::rr::RecordType::CNAME,
                ).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .record_iter()
                            .filter_map(|r| r.data().map(|d| d.to_string()))
                            .map(|s| normalize_domain(&s))
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (vec![], error_to_rcode(&e), Some(e.to_string())),
                }
            }
            _ => {
                // Generic lookup
                let lookup = resolver.lookup(
                    domain,
                    trust_dns_resolver::proto::rr::RecordType::Unknown(0),
                ).await;
                match lookup {
                    Ok(l) => {
                        let answers: Vec<String> = l
                            .record_iter()
                            .filter_map(|r| r.data().map(|d| d.to_string()))
                            .collect();
                        (answers, "NOERROR".to_string(), None)
                    }
                    Err(e) => (vec![], error_to_rcode(&e), Some(e.to_string())),
                }
            }
        }
    })
    .await;

    let elapsed = start.elapsed().as_millis() as u64;

    match timeout_result {
        Ok((answers, rcode, error)) => PropagationResolverResult {
            resolver: ip.to_string(),
            resolver_label: label.to_string(),
            answers,
            rcode,
            latency_ms: elapsed,
            error,
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

fn error_to_rcode(err: &trust_dns_resolver::error::ResolveError) -> String {
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
        assert_eq!(
            resolve_dns_server(Some("8.8.8.8"), None, None),
            "8.8.8.8"
        );
        assert_eq!(
            resolve_dns_server(Some("custom"), Some("9.9.9.9"), None),
            "9.9.9.9"
        );
    }
}
