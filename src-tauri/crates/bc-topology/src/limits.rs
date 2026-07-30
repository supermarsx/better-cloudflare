//! Central resource ceilings for native topology enrichment.

/// Authoritative DNS records can still contribute up to 10,000 hostnames.
pub const MAX_TOPOLOGY_HOSTS: usize = 10_000;
pub const MAX_HOSTNAME_BYTES: usize = 253;
pub const MAX_TOPOLOGY_HOST_BYTES: usize = MAX_TOPOLOGY_HOSTS * MAX_HOSTNAME_BYTES;

pub const MAX_SERVICE_HOSTS: usize = 32;
pub const MAX_TCP_SERVICE_PORTS: usize = 32;
pub const MAX_TCP_PROBE_PRODUCT: usize = MAX_SERVICE_HOSTS * MAX_TCP_SERVICE_PORTS;
pub const MAX_EXTRA_RESOLVERS: usize = 32;
pub const MAX_SELECTOR_BYTES: usize = 64;
pub const MAX_IP_LITERAL_BYTES: usize = 45;

pub const MAX_CUSTOM_URL_BYTES: usize = 2 * 1024;
pub const MAX_DOH_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_GEO_RESPONSE_BYTES: usize = 64 * 1024;
pub const MAX_DNS_ANSWERS: usize = 256;
pub const MAX_DNS_ANSWER_BYTES: usize = 4 * 1024;
pub const MAX_DNS_ANSWER_TOTAL_BYTES: usize = 256 * 1024;
pub const MAX_IPS_PER_FAMILY: usize = 16;
pub const MAX_REVERSE_HOSTNAMES_PER_IP: usize = 16;
pub const MAX_BATCH_GEO_IPS: usize = 20_000;
pub const MAX_GEO_COUNTRY_BYTES: usize = 128;
pub const MAX_GEO_COUNTRY_CODE_BYTES: usize = 8;
pub const MAX_ERROR_BYTES: usize = 1024;

pub const NETWORK_CONCURRENCY: usize = 8;
