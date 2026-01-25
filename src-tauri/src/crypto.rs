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

#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),
    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),
    #[error("Invalid format")]
    InvalidFormat,
}

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

    pub fn encrypt(&self, data: &str, password: &str) -> Result<String, CryptoError> {
        // Generate random salt
        let mut salt = [0u8; 16];
        OsRng.fill(&mut salt);

        // Derive key from password
        let mut key = vec![0u8; self.config.key_length];
        pbkdf2_hmac::<Sha256>(
            password.as_bytes(),
            &salt,
            self.config.iterations,
            &mut key,
        );

        // Generate random nonce
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        // Encrypt data
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
        
        let ciphertext = cipher
            .encrypt(nonce, data.as_bytes())
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        // Combine salt + nonce + ciphertext and encode as base64
        let mut result = Vec::new();
        result.extend_from_slice(&salt);
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);

        Ok(base64::engine::general_purpose::STANDARD.encode(&result))
    }

    pub fn decrypt(&self, encrypted: &str, password: &str) -> Result<String, CryptoError> {
        // Decode from base64
        let data = base64::engine::general_purpose::STANDARD
            .decode(encrypted)
            .map_err(|_| CryptoError::InvalidFormat)?;

        if data.len() < 28 {
            // 16 (salt) + 12 (nonce)
            return Err(CryptoError::InvalidFormat);
        }

        // Extract salt, nonce, and ciphertext
        let (salt, rest) = data.split_at(16);
        let (nonce_bytes, ciphertext) = rest.split_at(12);

        // Derive key from password
        let mut key = vec![0u8; self.config.key_length];
        pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, self.config.iterations, &mut key);

        // Decrypt data
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;
        
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

        String::from_utf8(plaintext)
            .map_err(|_| CryptoError::DecryptionFailed("Invalid UTF-8".to_string()))
    }

    pub async fn benchmark(&self, iterations: u32) -> Result<f64, CryptoError> {
        let start = std::time::Instant::now();
        
        let mut config = self.config.clone();
        config.iterations = iterations;
        let temp_crypto = CryptoManager::new(config);
        
        let test_data = "benchmark_test_data";
        let password = "benchmark_password";
        
        temp_crypto.encrypt(test_data, password)?;
        
        let elapsed = start.elapsed();
        Ok(elapsed.as_secs_f64() * 1000.0) // Convert to milliseconds
    }
}

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
