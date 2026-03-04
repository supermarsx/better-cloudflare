//! Thin re-export of [`bc_cloudflare_api`].

pub use bc_cloudflare_api::{
    CloudflareClient, DNSRecord, DNSRecordInput, Zone,
    // Firewall / WAF
    FirewallRule, FirewallRuleInput,
    IpAccessRule, WafRuleset,
    // Workers
    WorkerRoute,
    // Email Routing
    EmailRoutingRule, EmailRoutingSettings,
    // Page Rules
    PageRule,
};
