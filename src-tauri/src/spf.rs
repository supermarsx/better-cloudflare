use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::str::FromStr;
use trust_dns_resolver::TokioAsyncResolver;

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

async fn resolver() -> Result<TokioAsyncResolver, String> {
    TokioAsyncResolver::tokio_from_system_conf().map_err(|e| e.to_string())
}

async fn resolve_txt(resolver: &TokioAsyncResolver, domain: &str) -> Result<Vec<String>, String> {
    let lookup = resolver
        .txt_lookup(domain)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for record in lookup.iter() {
        let mut joined = String::new();
        for part in record.txt_data() {
            joined.push_str(&String::from_utf8_lossy(part));
        }
        out.push(joined);
    }
    Ok(out)
}

async fn resolve_a_aaaa(
    resolver: &TokioAsyncResolver,
    domain: &str,
) -> Result<Vec<IpAddr>, String> {
    let lookup = resolver
        .lookup_ip(domain)
        .await
        .map_err(|e| e.to_string())?;
    Ok(lookup.iter().collect())
}

async fn resolve_mx(
    resolver: &TokioAsyncResolver,
    domain: &str,
) -> Result<Vec<String>, String> {
    let lookup = resolver.mx_lookup(domain).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for record in lookup.iter() {
        out.push(record.exchange().to_utf8());
    }
    Ok(out)
}

async fn resolve_ptr(
    resolver: &TokioAsyncResolver,
    ip: IpAddr,
) -> Result<Vec<String>, String> {
    let lookup = resolver
        .reverse_lookup(ip)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for record in lookup.iter() {
        out.push(record.to_utf8());
    }
    Ok(out)
}

fn parse_spf(content: &str) -> Option<SPFRecord> {
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
            let core = if qualifier.is_some() { &part[1..] } else { part };
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
    resolver: &TokioAsyncResolver,
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

fn ip_matches_cidr(ip: IpAddr, cidr: &str) -> bool {
    if let Ok(net) = ipnet::IpNet::from_str(cidr) {
        return net.contains(&ip);
    }
    if let Ok(ip_only) = IpAddr::from_str(cidr) {
        return ip == ip_only;
    }
    false
}

pub async fn simulate_spf(domain: &str, ip: &str) -> Result<SPFSimulation, String> {
    let ip_addr = IpAddr::from_str(ip).map_err(|e| e.to_string())?;
    let resolver = resolver().await?;
    let mut lookups = 0_u32;
    let txt = get_spf_record(&resolver, domain, &mut lookups).await?;
    let parsed = txt
        .as_deref()
        .and_then(|t| parse_spf(t))
        .ok_or_else(|| "no spf record".to_string())
        .ok();
    if parsed.is_none() {
        return Ok(SPFSimulation {
            result: "neutral".to_string(),
            reasons: vec!["no spf record".to_string()],
            lookups,
        });
    }
    let parsed = parsed.unwrap();
    let mut max_lookups = 10_u32;

    async fn eval_mechanism(
        resolver: &TokioAsyncResolver,
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
                let res = simulate_spf(inc_domain, &ip.to_string()).await?;
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
        match eval_mechanism(&resolver, domain, ip_addr, m, &mut lookups, &mut max_lookups).await {
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
        let res = simulate_spf(&redirect, ip).await?;
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

pub async fn build_spf_graph(domain: &str) -> Result<SPFGraph, String> {
    let resolver = resolver().await?;
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut lookups = 0_u32;
    let mut cyclic = false;
    let mut visited = std::collections::HashSet::new();

    async fn walk(
        resolver: &TokioAsyncResolver,
        domain: &str,
        nodes: &mut Vec<SPFGraphNode>,
        edges: &mut Vec<SPFGraphEdge>,
        lookups: &mut u32,
        visited: &mut std::collections::HashSet<String>,
        cyclic: &mut bool,
        depth: u32,
        max_depth: u32,
    ) -> Result<(), String> {
        if depth > max_depth {
            return Ok(());
        }
        if visited.contains(domain) {
            *cyclic = true;
            return Ok(());
        }
        visited.insert(domain.to_string());
        let txt = get_spf_record(resolver, domain, lookups).await?;
        nodes.push(SPFGraphNode {
            domain: domain.to_string(),
            txt: txt.clone(),
        });
        let parsed = txt.as_deref().and_then(|t| parse_spf(t));
        if let Some(record) = parsed {
            for m in &record.mechanisms {
                if m.mechanism == "include" {
                    if let Some(target) = &m.value {
                        edges.push(SPFGraphEdge {
                            from: domain.to_string(),
                            to: target.clone(),
                            edge_type: "include".to_string(),
                        });
                        walk(
                            resolver,
                            target,
                            nodes,
                            edges,
                            lookups,
                            visited,
                            cyclic,
                            depth + 1,
                            max_depth,
                        )
                        .await?;
                    }
                }
            }
            for modif in &record.modifiers {
                if modif.key == "redirect" && !modif.value.is_empty() {
                    edges.push(SPFGraphEdge {
                        from: domain.to_string(),
                        to: modif.value.clone(),
                        edge_type: "redirect".to_string(),
                    });
                    walk(
                        resolver,
                        &modif.value,
                        nodes,
                        edges,
                        lookups,
                        visited,
                        cyclic,
                        depth + 1,
                        max_depth,
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    walk(
        &resolver,
        domain,
        &mut nodes,
        &mut edges,
        &mut lookups,
        &mut visited,
        &mut cyclic,
        0,
        10,
    )
    .await?;

    Ok(SPFGraph {
        nodes,
        edges,
        lookups,
        cyclic,
    })
}

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
