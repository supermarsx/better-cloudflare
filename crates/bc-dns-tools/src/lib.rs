//! # bc-dns-tools
//!
//! DNS record parsing, validation, import/export, and structured record
//! builders for SRV, TLSA, SSHFP, and NAPTR record types.
//!
//! This crate provides pure-computation utilities that operate on
//! [`bc_cloudflare_api::DNSRecord`] without any network or filesystem I/O.

mod export;
mod import;
mod structured;
mod validate;

pub use export::*;
pub use import::*;
pub use structured::*;
pub use validate::*;
