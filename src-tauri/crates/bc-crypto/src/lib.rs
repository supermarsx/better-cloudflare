//! # bc-crypto
//!
//! PBKDF2 key derivation and AES-256-GCM authenticated encryption.
//!
//! Provides [`CryptoManager`] for encrypting/decrypting secrets with a
//! user-supplied password and configurable iteration count.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use rand::rand_core::UnwrapErr;
use rand::{rngs::SysRng, CryptoRng, Rng};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use zeroize::Zeroizing;

pub const MIN_PBKDF2_ITERATIONS: u32 = 100_000;
pub const MAX_PBKDF2_ITERATIONS: u32 = 1_000_000;
pub const AES_256_KEY_LENGTH_BYTES: usize = 32;
pub const MAX_PLAINTEXT_BYTES: usize = 64 * 1024;
pub const MAX_PASSWORD_BYTES: usize = 4 * 1024;
pub const MAX_CIPHERTEXT_BYTES: usize = MAX_PLAINTEXT_BYTES + 16;
pub const MAX_ENVELOPE_BYTES: usize = 16 + 12 + MAX_CIPHERTEXT_BYTES;
pub const MAX_BASE64_CHARS: usize = MAX_ENVELOPE_BYTES.div_ceil(3) * 4;

const MIN_LEGACY_PBKDF2_ITERATIONS: u32 = 1;
const CANONICAL_ALGORITHM: &str = "AES-GCM";
const ALGORITHM_ALIAS: &str = "AES-256-GCM";
const ENVELOPE_PREFIX: &str = "bc1:";
const ENVELOPE_AAD: &[u8] = b"better-cloudflare:crypto-envelope:v1";
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 12;
const AUTH_TAG_BYTES: usize = 16;

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
    #[error("Invalid encryption configuration: {0}")]
    InvalidConfig(String),
    #[error("{field} exceeds the {max_bytes}-byte limit")]
    InputTooLarge {
        field: &'static str,
        max_bytes: usize,
    },
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
            algorithm: CANONICAL_ALGORITHM.to_string(),
        }
    }
}

impl EncryptionConfig {
    /// Validate a configuration used to decrypt an existing value. Iteration
    /// counts below the current write minimum remain readable for migration,
    /// but all resource ceilings and AES-256 invariants are still enforced.
    pub fn validated_for_decryption(mut self) -> Result<Self, CryptoError> {
        validate_iterations(
            self.iterations,
            MIN_LEGACY_PBKDF2_ITERATIONS,
            MAX_PBKDF2_ITERATIONS,
        )?;
        validate_key_length(self.key_length)?;
        self.algorithm = canonicalize_algorithm(&self.algorithm)?;
        Ok(self)
    }

    /// Validate a configuration used for a new encryption operation.
    pub fn validated_for_encryption(mut self) -> Result<Self, CryptoError> {
        validate_iterations(
            self.iterations,
            MIN_PBKDF2_ITERATIONS,
            MAX_PBKDF2_ITERATIONS,
        )?;
        validate_key_length(self.key_length)?;
        self.algorithm = canonicalize_algorithm(&self.algorithm)?;
        Ok(self)
    }
}

fn validate_iterations(iterations: u32, min: u32, max: u32) -> Result<(), CryptoError> {
    if !(min..=max).contains(&iterations) {
        return Err(CryptoError::InvalidConfig(format!(
            "PBKDF2 iterations must be between {min} and {max}"
        )));
    }
    Ok(())
}

fn validate_key_length(key_length: usize) -> Result<(), CryptoError> {
    if key_length != AES_256_KEY_LENGTH_BYTES {
        return Err(CryptoError::InvalidConfig(format!(
            "AES-256 key length must be exactly {AES_256_KEY_LENGTH_BYTES} bytes"
        )));
    }
    Ok(())
}

fn canonicalize_algorithm(algorithm: &str) -> Result<String, CryptoError> {
    match algorithm {
        CANONICAL_ALGORITHM | ALGORITHM_ALIAS => Ok(CANONICAL_ALGORITHM.to_string()),
        _ => Err(CryptoError::InvalidConfig(
            "algorithm must be AES-GCM".to_string(),
        )),
    }
}

pub fn validate_benchmark_iterations(iterations: u32) -> Result<(), CryptoError> {
    validate_iterations(iterations, MIN_PBKDF2_ITERATIONS, MAX_PBKDF2_ITERATIONS)
}

// ── Manager ─────────────────────────────────────────────────────────────────

/// High-level encryption / decryption facade.
#[derive(Default)]
pub struct CryptoManager {
    config: EncryptionConfig,
}

impl CryptoManager {
    pub fn new(config: EncryptionConfig) -> Result<Self, CryptoError> {
        Ok(Self {
            config: config.validated_for_decryption()?,
        })
    }

    pub fn new_for_encryption(config: EncryptionConfig) -> Result<Self, CryptoError> {
        Ok(Self {
            config: config.validated_for_encryption()?,
        })
    }

    pub fn get_config(&self) -> EncryptionConfig {
        self.config.clone()
    }

    pub fn update_config(&mut self, config: EncryptionConfig) -> Result<(), CryptoError> {
        self.config = config.validated_for_encryption()?;
        Ok(())
    }

    /// Encrypt `data` with `password`.
    ///
    /// Returns a versioned base64 envelope containing
    /// `salt (16) || nonce (12) || ciphertext || authentication tag`.
    pub fn encrypt(&self, data: &str, password: &str) -> Result<String, CryptoError> {
        let mut rng = UnwrapErr(SysRng);
        self.encrypt_with_rng(data, password, &mut rng)
    }

    fn encrypt_with_rng<R: CryptoRng + Rng>(
        &self,
        data: &str,
        password: &str,
        rng: &mut R,
    ) -> Result<String, CryptoError> {
        self.config.clone().validated_for_encryption()?;
        validate_bounded_input("plaintext", data.as_bytes(), MAX_PLAINTEXT_BYTES)?;
        validate_password(password)?;

        let mut salt = [0u8; SALT_BYTES];
        rng.fill_bytes(&mut salt);

        let mut key = Zeroizing::new([0u8; AES_256_KEY_LENGTH_BYTES]);
        pbkdf2_hmac::<Sha256>(
            password.as_bytes(),
            &salt,
            self.config.iterations,
            &mut key[..],
        );

        let mut nonce_bytes = [0u8; NONCE_BYTES];
        rng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let cipher = Aes256Gcm::new_from_slice(&key[..])
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: data.as_bytes(),
                    aad: ENVELOPE_AAD,
                },
            )
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let mut result = Vec::with_capacity(SALT_BYTES + NONCE_BYTES + ciphertext.len());
        result.extend_from_slice(&salt);
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);

        Ok(format!(
            "{ENVELOPE_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(&result)
        ))
    }

    /// Decrypt a versioned envelope or a legacy unprefixed envelope produced
    /// before version markers were introduced.
    pub fn decrypt(&self, encrypted: &str, password: &str) -> Result<String, CryptoError> {
        self.config.clone().validated_for_decryption()?;
        validate_password(password)?;

        let versioned = encrypted.starts_with(ENVELOPE_PREFIX);
        let encoded = encrypted.strip_prefix(ENVELOPE_PREFIX).unwrap_or(encrypted);
        if encoded.len() > MAX_BASE64_CHARS || !encoded.len().is_multiple_of(4) {
            return Err(CryptoError::InvalidFormat);
        }

        let data = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| CryptoError::InvalidFormat)?;

        if data.len() < SALT_BYTES + NONCE_BYTES + AUTH_TAG_BYTES || data.len() > MAX_ENVELOPE_BYTES
        {
            return Err(CryptoError::InvalidFormat);
        }

        let (salt, rest) = data.split_at(SALT_BYTES);
        let (nonce_bytes, ciphertext) = rest.split_at(NONCE_BYTES);
        if ciphertext.len() > MAX_CIPHERTEXT_BYTES {
            return Err(CryptoError::InvalidFormat);
        }

        let mut key = Zeroizing::new([0u8; AES_256_KEY_LENGTH_BYTES]);
        pbkdf2_hmac::<Sha256>(
            password.as_bytes(),
            salt,
            self.config.iterations,
            &mut key[..],
        );

        let cipher = Aes256Gcm::new_from_slice(&key[..])
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

        let nonce = Nonce::from_slice(nonce_bytes);
        let payload = Payload {
            msg: ciphertext,
            aad: if versioned { ENVELOPE_AAD } else { &[] },
        };
        let plaintext = cipher.decrypt(nonce, payload).map_err(|_| {
            CryptoError::DecryptionFailed(
                "authentication failed; the password or ciphertext is invalid".to_string(),
            )
        })?;

        if plaintext.len() > MAX_PLAINTEXT_BYTES {
            return Err(CryptoError::InputTooLarge {
                field: "plaintext",
                max_bytes: MAX_PLAINTEXT_BYTES,
            });
        }

        String::from_utf8(plaintext)
            .map_err(|_| CryptoError::DecryptionFailed("Invalid UTF-8".to_string()))
    }

    /// Benchmark an encrypt operation at the given iteration count; returns
    /// elapsed time in **milliseconds**.
    pub fn benchmark(&self, iterations: u32) -> Result<f64, CryptoError> {
        validate_benchmark_iterations(iterations)?;

        let mut password_bytes = Zeroizing::new([0u8; AES_256_KEY_LENGTH_BYTES]);
        UnwrapErr(SysRng).fill_bytes(&mut password_bytes[..]);
        let password =
            Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&password_bytes[..]));

        let start = std::time::Instant::now();

        let mut config = self.config.clone();
        config.iterations = iterations;
        let temp_crypto = CryptoManager::new_for_encryption(config)?;

        temp_crypto.encrypt("benchmark_test_data", password.as_str())?;

        Ok(start.elapsed().as_secs_f64() * 1000.0)
    }
}

fn validate_bounded_input(
    field: &'static str,
    value: &[u8],
    max_bytes: usize,
) -> Result<(), CryptoError> {
    if value.len() > max_bytes {
        return Err(CryptoError::InputTooLarge { field, max_bytes });
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), CryptoError> {
    if password.is_empty() {
        return Err(CryptoError::InvalidConfig(
            "password must not be empty".to_string(),
        ));
    }
    validate_bounded_input("password", password.as_bytes(), MAX_PASSWORD_BYTES)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rand_core::{Infallible, TryCryptoRng, TryRng};

    struct DeterministicCryptoRng {
        next: u8,
    }

    impl DeterministicCryptoRng {
        fn new(next: u8) -> Self {
            Self { next }
        }
    }

    // rand_core 0.10 blanket-implements Rng and CryptoRng for any
    // TryRng<Error = Infallible>, so the fallible trait is the one to implement.
    impl TryRng for DeterministicCryptoRng {
        type Error = Infallible;

        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            let mut bytes = [0u8; 4];
            self.try_fill_bytes(&mut bytes)?;
            Ok(u32::from_le_bytes(bytes))
        }

        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            let mut bytes = [0u8; 8];
            self.try_fill_bytes(&mut bytes)?;
            Ok(u64::from_le_bytes(bytes))
        }

        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), Self::Error> {
            for byte in dest {
                *byte = self.next;
                self.next = self.next.wrapping_add(1);
            }
            Ok(())
        }
    }

    impl TryCryptoRng for DeterministicCryptoRng {}

    fn decode_versioned(encrypted: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(encrypted.strip_prefix(ENVELOPE_PREFIX).unwrap())
            .unwrap()
    }

    #[test]
    fn test_encrypt_decrypt() {
        let crypto = CryptoManager::default();
        let data = "test_data";
        let password = "test_password";

        let encrypted = crypto.encrypt(data, password).unwrap();
        let decrypted = crypto.decrypt(&encrypted, password).unwrap();

        assert_eq!(data, decrypted);
        assert!(encrypted.starts_with(ENVELOPE_PREFIX));
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
    fn encryption_consumes_fresh_nonce_material_for_every_envelope() {
        let crypto = CryptoManager::default();
        let mut rng = DeterministicCryptoRng::new(0);

        let first = decode_versioned(
            &crypto
                .encrypt_with_rng("same data", "same password", &mut rng)
                .unwrap(),
        );
        let second = decode_versioned(
            &crypto
                .encrypt_with_rng("same data", "same password", &mut rng)
                .unwrap(),
        );

        let first_random_material = &first[..SALT_BYTES + NONCE_BYTES];
        let second_random_material = &second[..SALT_BYTES + NONCE_BYTES];
        assert_eq!(
            first_random_material,
            (0..(SALT_BYTES + NONCE_BYTES))
                .map(|byte| byte as u8)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            second_random_material,
            ((SALT_BYTES + NONCE_BYTES)..(2 * (SALT_BYTES + NONCE_BYTES)))
                .map(|byte| byte as u8)
                .collect::<Vec<_>>()
        );
        assert_ne!(
            &first[SALT_BYTES..SALT_BYTES + NONCE_BYTES],
            &second[SALT_BYTES..SALT_BYTES + NONCE_BYTES]
        );
    }

    #[test]
    fn tampering_with_any_envelope_component_fails_authentication() {
        let crypto = CryptoManager::default();
        let mut rng = DeterministicCryptoRng::new(0);
        let encrypted = crypto
            .encrypt_with_rng("authenticated", "password", &mut rng)
            .unwrap();
        let envelope = decode_versioned(&encrypted);

        for index in [0, SALT_BYTES, SALT_BYTES + NONCE_BYTES, envelope.len() - 1] {
            let mut tampered = envelope.clone();
            tampered[index] ^= 1;
            let encoded = format!(
                "{ENVELOPE_PREFIX}{}",
                base64::engine::general_purpose::STANDARD.encode(tampered)
            );
            assert!(
                matches!(
                    crypto.decrypt(&encoded, "password"),
                    Err(CryptoError::DecryptionFailed(_))
                ),
                "tampering at byte {index} was not rejected"
            );
        }
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

    #[test]
    fn config_iteration_boundaries_fail_closed() {
        let below = EncryptionConfig {
            iterations: MIN_PBKDF2_ITERATIONS - 1,
            ..EncryptionConfig::default()
        };
        assert!(below.clone().validated_for_encryption().is_err());
        assert!(below.validated_for_decryption().is_ok());

        for iterations in [MIN_PBKDF2_ITERATIONS, MAX_PBKDF2_ITERATIONS] {
            let config = EncryptionConfig {
                iterations,
                ..EncryptionConfig::default()
            };
            assert!(config.validated_for_encryption().is_ok());
        }

        let above = EncryptionConfig {
            iterations: MAX_PBKDF2_ITERATIONS + 1,
            ..EncryptionConfig::default()
        };
        assert!(above.clone().validated_for_encryption().is_err());
        assert!(CryptoManager::new(above).is_err());
    }

    #[test]
    fn benchmark_uses_an_ephemeral_password_and_checks_boundaries() {
        assert!(validate_benchmark_iterations(MIN_PBKDF2_ITERATIONS - 1).is_err());
        assert!(validate_benchmark_iterations(MIN_PBKDF2_ITERATIONS).is_ok());
        assert!(validate_benchmark_iterations(MAX_PBKDF2_ITERATIONS).is_ok());
        assert!(validate_benchmark_iterations(MAX_PBKDF2_ITERATIONS + 1).is_err());

        let elapsed = CryptoManager::default()
            .benchmark(MIN_PBKDF2_ITERATIONS)
            .expect("benchmark must encrypt with a generated password");
        assert!(elapsed.is_finite() && elapsed >= 0.0);
    }

    #[test]
    fn key_length_and_algorithm_are_authoritative() {
        for key_length in [AES_256_KEY_LENGTH_BYTES - 1, AES_256_KEY_LENGTH_BYTES + 1] {
            let config = EncryptionConfig {
                key_length,
                ..EncryptionConfig::default()
            };
            assert!(CryptoManager::new(config).is_err());
        }

        let alias = EncryptionConfig {
            algorithm: ALGORITHM_ALIAS.to_string(),
            ..EncryptionConfig::default()
        };
        assert_eq!(
            CryptoManager::new(alias).unwrap().get_config().algorithm,
            CANONICAL_ALGORITHM
        );

        let unsupported = EncryptionConfig {
            algorithm: "AES-256-CBC".to_string(),
            ..EncryptionConfig::default()
        };
        assert!(CryptoManager::new(unsupported).is_err());
    }

    #[test]
    fn plaintext_and_password_boundaries_are_bounded() {
        let crypto = CryptoManager::default();
        let at_plaintext_limit = "a".repeat(MAX_PLAINTEXT_BYTES);
        let encrypted = crypto
            .encrypt(&at_plaintext_limit, "password")
            .expect("exact plaintext limit must encrypt");
        assert_eq!(
            crypto.decrypt(&encrypted, "password").unwrap(),
            at_plaintext_limit
        );

        let over_plaintext_limit = "a".repeat(MAX_PLAINTEXT_BYTES + 1);
        assert!(matches!(
            crypto.encrypt(&over_plaintext_limit, "password"),
            Err(CryptoError::InputTooLarge {
                field: "plaintext",
                ..
            })
        ));

        let at_password_limit = "p".repeat(MAX_PASSWORD_BYTES);
        assert!(crypto.encrypt("secret", &at_password_limit).is_ok());
        let over_password_limit = "p".repeat(MAX_PASSWORD_BYTES + 1);
        assert!(matches!(
            crypto.encrypt("secret", &over_password_limit),
            Err(CryptoError::InputTooLarge {
                field: "password",
                ..
            })
        ));
    }

    #[test]
    fn envelope_size_boundary_is_enforced_before_decrypt() {
        let crypto = CryptoManager::default();

        let at_limit = format!(
            "{ENVELOPE_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_ENVELOPE_BYTES])
        );
        assert!(matches!(
            crypto.decrypt(&at_limit, "password"),
            Err(CryptoError::DecryptionFailed(_))
        ));

        let oversized = format!(
            "{ENVELOPE_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_ENVELOPE_BYTES + 1])
        );
        assert!(matches!(
            crypto.decrypt(&oversized, "password"),
            Err(CryptoError::InvalidFormat)
        ));
    }

    #[test]
    fn legacy_unprefixed_envelope_remains_decryptable() {
        let crypto = CryptoManager::default();
        let mut rng = DeterministicCryptoRng::new(0);
        let mut salt = [0u8; SALT_BYTES];
        rng.fill_bytes(&mut salt);
        let mut nonce_bytes = [0u8; NONCE_BYTES];
        rng.fill_bytes(&mut nonce_bytes);
        let mut key = Zeroizing::new([0u8; AES_256_KEY_LENGTH_BYTES]);
        pbkdf2_hmac::<Sha256>(b"password", &salt, crypto.config.iterations, &mut key[..]);
        let cipher = Aes256Gcm::new_from_slice(&key[..]).unwrap();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                b"legacy-compatible".as_ref(),
            )
            .unwrap();
        let mut legacy_bytes = Vec::with_capacity(SALT_BYTES + NONCE_BYTES + ciphertext.len());
        legacy_bytes.extend_from_slice(&salt);
        legacy_bytes.extend_from_slice(&nonce_bytes);
        legacy_bytes.extend_from_slice(&ciphertext);
        let legacy = base64::engine::general_purpose::STANDARD.encode(legacy_bytes);
        assert_eq!(
            crypto.decrypt(&legacy, "password").unwrap(),
            "legacy-compatible"
        );
    }

    #[test]
    fn version_marker_is_authenticated() {
        let crypto = CryptoManager::default();
        let versioned = crypto.encrypt("versioned", "password").unwrap();
        let downgraded = versioned.strip_prefix(ENVELOPE_PREFIX).unwrap();
        assert!(matches!(
            crypto.decrypt(downgraded, "password"),
            Err(CryptoError::DecryptionFailed(_))
        ));
    }
}
