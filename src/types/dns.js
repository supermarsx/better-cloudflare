/**
 * Supported encryption algorithms used by the CryptoManager when encrypting
 * API keys in storage. AES-GCM is preferred for authenticated encryption.
 */
export const ENCRYPTION_ALGORITHMS = ['AES-GCM', 'AES-CBC'];
/**
 * Supported record types used across the UI and validation schema.
 */
export const RECORD_TYPES = [
    'A',
    'AAAA',
    'CNAME',
    'MX',
    'TXT',
    'SRV',
    'NS',
    'PTR',
    'CAA'
];
/**
 * TTL presets used in the UI for quick selection (seconds or 'auto')
 */
export const TTL_PRESETS = ['auto', 300, 900, 3600, 86400];
