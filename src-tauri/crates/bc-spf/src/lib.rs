//! # bc-spf
//!
//! SPF (Sender Policy Framework) record parser, RFC-compliant simulator,
//! and include/redirect dependency graph builder.

use hickory_resolver::proto::rr::RData;
use hickory_resolver::TokioResolver;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::IpAddr;
use std::str::FromStr;

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SPFMechanism {
    pub qualifier: Option<String>,
    pub mechanism: String,
    pub value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SPFModifier {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SPFRecord {
    pub version: String,
    pub mechanisms: Vec<SPFMechanism>,
    pub modifiers: Vec<SPFModifier>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SPFSimulation {
    pub result: String,
    pub reasons: Vec<String>,
    pub lookups: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SPFGraphNode {
    pub domain: String,
    pub txt: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SPFGraphEdge {
    pub from: String,
    pub to: String,
    pub edge_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SPFGraph {
    pub nodes: Vec<SPFGraphNode>,
    pub edges: Vec<SPFGraphEdge>,
    pub lookups: u32,
    pub cyclic: bool,
}

// ── Resolver helpers ────────────────────────────────────────────────────────

async fn resolver() -> Result<TokioResolver, String> {
    TokioResolver::builder_tokio()
        .and_then(|builder| builder.build())
        .map_err(|e| e.to_string())
}

async fn resolve_txt(resolver: &TokioResolver, domain: &str) -> Result<Vec<String>, String> {
    let lookup = resolver
        .txt_lookup(domain)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for record in lookup.answers() {
        if let RData::TXT(txt) = &record.data {
            let mut joined = String::new();
            for part in &txt.txt_data {
                joined.push_str(&String::from_utf8_lossy(part));
            }
            out.push(joined);
        }
    }
    Ok(out)
}

async fn resolve_a_aaaa(resolver: &TokioResolver, domain: &str) -> Result<Vec<IpAddr>, String> {
    let lookup = resolver
        .lookup_ip(domain)
        .await
        .map_err(|e| e.to_string())?;
    Ok(lookup.iter().collect())
}

async fn resolve_mx(resolver: &TokioResolver, domain: &str) -> Result<Vec<String>, String> {
    let lookup = resolver
        .mx_lookup(domain)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for record in lookup.answers() {
        if let RData::MX(mx) = &record.data {
            out.push(mx.exchange.to_utf8());
        }
    }
    Ok(out)
}

async fn resolve_ptr(resolver: &TokioResolver, ip: IpAddr) -> Result<Vec<String>, String> {
    let lookup = resolver
        .reverse_lookup(ip)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for record in lookup.answers() {
        if let RData::PTR(ptr) = &record.data {
            out.push(ptr.to_string());
        }
    }
    Ok(out)
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/// Parse an SPF TXT record string into structured data.
pub fn parse_spf(content: &str) -> Option<SPFRecord> {
    let trimmed = content.trim();
    if !trimmed.to_lowercase().starts_with("v=spf1") {
        return None;
    }
    let rest = trimmed[6..].trim();
    let mut mechanisms = Vec::new();
    let mut modifiers = Vec::new();
    if !rest.is_empty() {
        for part in rest.split_whitespace() {
            if part.contains('=') {
                let mut splits = part.splitn(2, '=');
                let key = splits.next().unwrap_or("").to_lowercase();
                let value = splits.next().unwrap_or("").to_string();
                modifiers.push(SPFModifier { key, value });
                continue;
            }
            let mut chars = part.chars();
            let first = chars.next().unwrap_or('+');
            let qualifier = if "+-~?".contains(first) {
                Some(first.to_string())
            } else {
                None
            };
            let core = if qualifier.is_some() {
                &part[1..]
            } else {
                part
            };
            let mut mech_split = core.splitn(2, ':');
            let mechanism = mech_split.next().unwrap_or("").to_lowercase();
            let value = mech_split.next().map(|s| s.to_string());
            mechanisms.push(SPFMechanism {
                qualifier,
                mechanism,
                value,
            });
        }
    }
    Some(SPFRecord {
        version: "v=spf1".to_string(),
        mechanisms,
        modifiers,
    })
}

async fn get_spf_record(
    resolver: &TokioResolver,
    domain: &str,
    lookups: &mut u32,
) -> Result<Option<String>, String> {
    *lookups += 1;
    let records = resolve_txt(resolver, domain).await?;
    for txt in records {
        if txt.to_lowercase().starts_with("v=spf1") {
            return Ok(Some(txt));
        }
    }
    Ok(None)
}

/// Check whether `ip` falls within `cidr` (or matches a bare IP).
pub fn ip_matches_cidr(ip: IpAddr, cidr: &str) -> bool {
    if let Ok(net) = ipnet::IpNet::from_str(cidr) {
        return net.contains(&ip);
    }
    if let Ok(ip_only) = IpAddr::from_str(cidr) {
        return ip == ip_only;
    }
    false
}

// ── Simulation ──────────────────────────────────────────────────────────────

/// Evaluate SPF policy for `domain` against `ip`.
pub async fn simulate_spf(domain: &str, ip: &str) -> Result<SPFSimulation, String> {
    let ip_addr = IpAddr::from_str(ip).map_err(|e| e.to_string())?;
    let resolver = resolver().await?;
    let mut lookups = 0_u32;
    let txt = get_spf_record(&resolver, domain, &mut lookups).await?;
    let parsed = txt.as_deref().and_then(parse_spf);
    let parsed = match parsed {
        Some(p) => p,
        None => {
            return Ok(SPFSimulation {
                result: "neutral".to_string(),
                reasons: vec!["no spf record".to_string()],
                lookups,
            });
        }
    };
    let mut max_lookups = 10_u32;

    async fn eval_mechanism(
        resolver: &TokioResolver,
        domain: &str,
        ip: IpAddr,
        m: &SPFMechanism,
        lookups: &mut u32,
        max_lookups: &mut u32,
    ) -> Result<Option<bool>, String> {
        match m.mechanism.as_str() {
            "ip4" | "ip6" => {
                if let Some(val) = &m.value {
                    return Ok(Some(ip_matches_cidr(ip, val)));
                }
                Ok(Some(false))
            }
            "a" => {
                *lookups += 1;
                if *lookups > *max_lookups {
                    return Err("lookup limit".to_string());
                }
                let target = m.value.as_deref().unwrap_or(domain);
                let addrs = resolve_a_aaaa(resolver, target).await?;
                Ok(Some(addrs.contains(&ip)))
            }
            "mx" => {
                *lookups += 1;
                if *lookups > *max_lookups {
                    return Err("lookup limit".to_string());
                }
                let target = m.value.as_deref().unwrap_or(domain);
                let hosts = resolve_mx(resolver, target).await?;
                for host in hosts {
                    let addrs = resolve_a_aaaa(resolver, &host).await?;
                    if addrs.contains(&ip) {
                        return Ok(Some(true));
                    }
                }
                Ok(Some(false))
            }
            "ptr" => {
                *lookups += 1;
                if *lookups > *max_lookups {
                    return Err("lookup limit".to_string());
                }
                let ptrs = resolve_ptr(resolver, ip).await?;
                let suffix = m.value.as_deref().unwrap_or(domain).to_lowercase();
                for ptr in ptrs {
                    if ptr.to_lowercase().ends_with(&suffix) {
                        let addrs = resolve_a_aaaa(resolver, &ptr).await?;
                        if addrs.contains(&ip) {
                            return Ok(Some(true));
                        }
                    }
                }
                Ok(Some(false))
            }
            "include" => {
                *lookups += 1;
                if *lookups > *max_lookups {
                    return Err("lookup limit".to_string());
                }
                let inc_domain = m.value.as_deref().unwrap_or("");
                let res = Box::pin(simulate_spf(inc_domain, &ip.to_string())).await?;
                *lookups += res.lookups;
                Ok(Some(res.result == "pass"))
            }
            "exists" => {
                *lookups += 1;
                if *lookups > *max_lookups {
                    return Err("lookup limit".to_string());
                }
                let target = m.value.as_deref().unwrap_or("");
                let addrs = resolve_a_aaaa(resolver, target).await?;
                Ok(Some(!addrs.is_empty()))
            }
            "all" => Ok(Some(true)),
            _ => Ok(None),
        }
    }

    for m in &parsed.mechanisms {
        match eval_mechanism(
            &resolver,
            domain,
            ip_addr,
            m,
            &mut lookups,
            &mut max_lookups,
        )
        .await
        {
            Ok(Some(true)) => {
                let qualifier = m.qualifier.clone().unwrap_or_else(|| "+".to_string());
                let result = match qualifier.as_str() {
                    "-" => "fail",
                    "~" => "softfail",
                    "?" => "neutral",
                    _ => "pass",
                };
                return Ok(SPFSimulation {
                    result: result.to_string(),
                    reasons: vec![format!("matched mechanism {}", m.mechanism)],
                    lookups,
                });
            }
            Ok(Some(false)) => continue,
            Ok(None) => continue,
            Err(_) => {
                return Ok(SPFSimulation {
                    result: "permerror".to_string(),
                    reasons: vec!["lookup limit reached".to_string()],
                    lookups,
                });
            }
        }
    }

    if let Some(redirect) = parsed
        .modifiers
        .iter()
        .find(|m| m.key == "redirect")
        .map(|m| m.value.clone())
    {
        let res = Box::pin(simulate_spf(&redirect, ip)).await?;
        return Ok(SPFSimulation {
            result: res.result,
            reasons: res.reasons,
            lookups: lookups + res.lookups,
        });
    }

    Ok(SPFSimulation {
        result: "neutral".to_string(),
        reasons: vec!["no matching mechanism".to_string()],
        lookups,
    })
}

// ── Graph builder ───────────────────────────────────────────────────────────

struct SPFGraphWalker<'a> {
    resolver: &'a TokioResolver,
    nodes: Vec<SPFGraphNode>,
    edges: Vec<SPFGraphEdge>,
    lookups: u32,
    visited: HashSet<String>,
    cyclic: bool,
    max_depth: u32,
}

impl<'a> SPFGraphWalker<'a> {
    fn new(resolver: &'a TokioResolver, max_depth: u32) -> Self {
        Self {
            resolver,
            nodes: Vec::new(),
            edges: Vec::new(),
            lookups: 0,
            visited: HashSet::new(),
            cyclic: false,
            max_depth,
        }
    }

    async fn walk(&mut self, domain: &str, depth: u32) -> Result<(), String> {
        if depth > self.max_depth {
            return Ok(());
        }
        if self.visited.contains(domain) {
            self.cyclic = true;
            return Ok(());
        }
        self.visited.insert(domain.to_string());
        let txt = get_spf_record(self.resolver, domain, &mut self.lookups).await?;
        self.nodes.push(SPFGraphNode {
            domain: domain.to_string(),
            txt: txt.clone(),
        });
        let parsed = txt.as_deref().and_then(parse_spf);
        if let Some(record) = parsed {
            for m in &record.mechanisms {
                if m.mechanism == "include" {
                    if let Some(target) = &m.value {
                        self.edges.push(SPFGraphEdge {
                            from: domain.to_string(),
                            to: target.clone(),
                            edge_type: "include".to_string(),
                        });
                        Box::pin(self.walk(target, depth + 1)).await?;
                    }
                }
            }
            for modif in &record.modifiers {
                if modif.key == "redirect" && !modif.value.is_empty() {
                    self.edges.push(SPFGraphEdge {
                        from: domain.to_string(),
                        to: modif.value.clone(),
                        edge_type: "redirect".to_string(),
                    });
                    Box::pin(self.walk(&modif.value, depth + 1)).await?;
                }
            }
        }
        Ok(())
    }
}

/// Build a dependency graph of SPF include/redirect chains.
pub async fn build_spf_graph(domain: &str) -> Result<SPFGraph, String> {
    let resolver = resolver().await?;
    let mut walker = SPFGraphWalker::new(&resolver, 10);
    walker.walk(domain, 0).await?;

    Ok(SPFGraph {
        nodes: walker.nodes,
        edges: walker.edges,
        lookups: walker.lookups,
        cyclic: walker.cyclic,
    })
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;
    use std::str::FromStr;

    #[test]
    fn parse_spf_basic() {
        let record = "v=spf1 ip4:192.0.2.0/24 -all redirect=example.com";
        let parsed = parse_spf(record).expect("parse spf");
        assert_eq!(parsed.version, "v=spf1");
        assert_eq!(parsed.mechanisms.len(), 2);
        assert_eq!(parsed.mechanisms[0].mechanism, "ip4");
        assert_eq!(parsed.mechanisms[0].value.as_deref(), Some("192.0.2.0/24"));
        assert_eq!(parsed.mechanisms[1].mechanism, "all");
        assert_eq!(parsed.mechanisms[1].qualifier.as_deref(), Some("-"));
        assert_eq!(parsed.modifiers.len(), 1);
        assert_eq!(parsed.modifiers[0].key, "redirect");
        assert_eq!(parsed.modifiers[0].value, "example.com");
    }

    #[test]
    fn ip_matches_cidr_ipv4_ipv6() {
        let ipv4 = IpAddr::from_str("192.0.2.5").expect("ipv4");
        assert!(ip_matches_cidr(ipv4, "192.0.2.0/24"));
        assert!(!ip_matches_cidr(ipv4, "198.51.100.0/24"));

        let ipv6 = IpAddr::from_str("2001:db8::1").expect("ipv6");
        assert!(ip_matches_cidr(ipv6, "2001:db8::/32"));
        assert!(!ip_matches_cidr(ipv6, "2001:db9::/32"));
    }
}
