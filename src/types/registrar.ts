/**
 * Types for domain registrar monitoring.
 *
 * These are the frontend-side types that mirror the shapes the Rust backend
 * returns via Tauri commands. The backend is responsible for all API requests,
 * credential storage and data normalisation – the frontend only receives
 * these already-normalised shapes.
 */

/** Supported registrar provider identifiers. */
export type RegistrarProvider =
  | "cloudflare"
  | "porkbun"
  | "namecheap"
  | "godaddy"
  | "google"
  | "namecom";

/** Human-friendly labels for each registrar. */
export const REGISTRAR_LABELS: Record<RegistrarProvider, string> = {
  cloudflare: "Cloudflare Registrar",
  porkbun: "Porkbun",
  namecheap: "Namecheap",
  godaddy: "GoDaddy",
  google: "Google Domains",
  namecom: "Name.com",
};

/** Nameserver configuration for a domain. */
export interface Nameservers {
  current: string[];
  is_custom: boolean;
}

/** DNSSEC status for a domain. */
export interface DNSSECStatus {
  enabled: boolean;
  ds_records?: Array<{
    key_tag: number;
    algorithm: number;
    digest_type: number;
    digest: string;
  }>;
}

/** Domain lock / auto-renew flags. */
export interface DomainLocks {
  transfer_lock: boolean;
  auto_renew: boolean;
}

/** Privacy / WHOIS protection status. */
export interface PrivacyStatus {
  enabled: boolean;
  service_name?: string;
}

/** Contact information associated with a registration (may be redacted). */
export interface DomainContact {
  first_name?: string;
  last_name?: string;
  organization?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  country?: string;
}

/**
 * Unified domain information returned by backend registrar commands.
 * The Rust backend normalises every registrar's API response into this shape.
 */
export interface DomainInfo {
  domain: string;
  registrar: RegistrarProvider;
  status: DomainStatus;
  created_at: string;
  expires_at: string;
  updated_at?: string;
  nameservers: Nameservers;
  locks: DomainLocks;
  dnssec: DNSSECStatus;
  privacy: PrivacyStatus;
  contact?: DomainContact;
}

/** Possible domain lifecycle states. */
export type DomainStatus =
  | "active"
  | "expired"
  | "pending"
  | "pending_transfer"
  | "redemption"
  | "locked"
  | "unknown";

/**
 * Stored registrar credential reference (only metadata – the backend
 * stores the actual secrets securely).
 */
export interface RegistrarCredential {
  /** Unique id for the credential set */
  id: string;
  /** Which registrar this credential belongs to */
  provider: RegistrarProvider;
  /** User-friendly label */
  label: string;
  /** Optional username (Namecheap, Name.com) */
  username?: string;
  /** Optional email */
  email?: string;
  /** ISO timestamp when added */
  created_at: string;
}

/** Health check result for a single domain. */
export interface DomainHealthCheck {
  domain: string;
  status: "healthy" | "warning" | "critical";
  checks: DomainCheck[];
  checked_at: string;
}

export interface DomainCheck {
  name: string;
  passed: boolean;
  severity: "info" | "warning" | "critical";
  message: string;
}
