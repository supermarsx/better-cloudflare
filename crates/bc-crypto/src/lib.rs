//! # bc-crypto
//!
//! PBKDF2 key derivation and AES-256-GCM authenticated encryption.
//!
//! Provides [`CryptoManager`] for encrypting/decrypting secrets with a
//! user-supplied password and configurable iteration count.

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;

// ── Error type ──────────────────────────────────────────────────────────────

/// Errors that can occur during cryptographic operations.
#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),
    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),
    #[error("Invalid format")]
    InvalidFormat,
}

// ── Configuration ───────────────────────────────────────────────────────────

/// Tunable parameters for the PBKDF2 + AES-256-GCM pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptionConfig {
    pub iterations: u32,
    pub key_length: usize,
    pub algorithm: String,
}

impl Default for EncryptionConfig {
    fn default() -> Self {
        Self {
            iterations: 100_000,
            key_length: 32,
            algorithm: "AES-256-GCM".to_string(),
        }
    }
}

// ── Manager ─────────────────────────────────────────────────────────────────

/// High-level encryption / decryption facade.
pub struct CryptoManager {
    config: EncryptionConfig,
}

impl Default for CryptoManager {
    fn default() -> Self {
        Self {
            config: EncryptionConfig::default(),
        }
    }
}

impl CryptoManager {
    pub fn new(config: EncryptionConfig) -> Self {
        Self { config }
    }

    pub fn get_config(&self) -> EncryptionConfig {
        self.config.clone()
    }

    pub fn update_config(&mut self, config: EncryptionConfig) {
        self.config = config;
    }

    /// Encrypt `data` with `password`.
    ///
    /// Returns a base64-encoded blob containing `salt (16) || nonce (12) || ciphertext`.
    pub fn encrypt(&self, data: &str, password: &str) -> Result<String, CryptoError> {
        let mut salt = [0u8; 16];
        OsRng.fill(&mut salt);

        let mut key = vec![0u8; self.config.key_length];
        pbkdf2_hmac::<Sha256>(
            password.as_bytes(),
            &salt,
            self.config.iterations,
            &mut key,
        );

        let mut nonce_bytes = [0u8; 12];
        OsRng.fill(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let ciphertext = cipher
            .encrypt(nonce, data.as_bytes())
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let mut result = Vec::with_capacity(16 + 12 + ciphertext.len());
        result.extend_from_slice(&salt);
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);

        Ok(base64::engine::general_purpose::STANDARD.encode(&result))
    }

    /// Decrypt a base64-encoded blob previously produced by [`Self::encrypt`].
    pub fn decrypt(&self, encrypted: &str, password: &str) -> Result<String, CryptoError> {
        let data = base64::engine::general_purpose::STANDARD
            .decode(encrypted)
            .map_err(|_| CryptoError::InvalidFormat)?;

        if data.len() < 28 {
            return Err(CryptoError::InvalidFormat);
        }

        let (salt, rest) = data.split_at(16);
        let (nonce_bytes, ciphertext) = rest.split_at(12);

        let mut key = vec![0u8; self.config.key_length];
        pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, self.config.iterations, &mut key);

        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

        String::from_utf8(plaintext)
            .map_err(|_| CryptoError::DecryptionFailed("Invalid UTF-8".to_string()))
    }

    /// Benchmark an encrypt operation at the given iteration count; returns
    /// elapsed time in **milliseconds**.
    pub async fn benchmark(&self, iterations: u32) -> Result<f64, CryptoError> {
        let start = std::time::Instant::now();

        let mut config = self.config.clone();
        config.iterations = iterations;
        let temp_crypto = CryptoManager::new(config);

        temp_crypto.encrypt("benchmark_test_data", "benchmark_password")?;

        Ok(start.elapsed().as_secs_f64() * 1000.0)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt() {
        let crypto = CryptoManager::default();
        let data = "test_data";
        let password = "test_password";

        let encrypted = crypto.encrypt(data, password).unwrap();
        let decrypted = crypto.decrypt(&encrypted, password).unwrap();

        assert_eq!(data, decrypted);
    }

    #[test]
    fn test_wrong_password() {
        let crypto = CryptoManager::default();
        let data = "test_data";
        let password = "test_password";
        let wrong_password = "wrong_password";

        let encrypted = crypto.encrypt(data, password).unwrap();
        let result = crypto.decrypt(&encrypted, wrong_password);

        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_base64() {
        let crypto = CryptoManager::default();
        let result = crypto.decrypt("not-base64", "password");
        assert!(matches!(result, Err(CryptoError::InvalidFormat)));
    }

    #[test]
    fn test_too_short_payload() {
        let crypto = CryptoManager::default();
        let short = base64::engine::general_purpose::STANDARD.encode([0u8; 10]);
        let result = crypto.decrypt(&short, "password");
        assert!(matches!(result, Err(CryptoError::InvalidFormat)));
    }
}
