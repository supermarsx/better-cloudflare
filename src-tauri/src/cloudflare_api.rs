//! Thin re-export of [`bc_cloudflare_api`].

pub use bc_cloudflare_api::{
    CloudflareClient,
    DNSRecord,
    DNSRecordInput,
    // Email Routing
    EmailRoutingRule,
    EmailRoutingSettings,
    // Firewall / WAF
    FirewallRule,
    FirewallRuleInput,
    IpAccessRule,
    // Page Rules
    PageRule,
    WafRuleset,
    // Workers
    WorkerRoute,
    Zone,
};
