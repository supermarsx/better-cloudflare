use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::{alphabet, Engine};
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

pub use bc_storage::Storage;

/// Legacy passkey records contain only untrusted browser JSON. They do not
/// contain a public key produced by verified registration, trusted RP/origin
/// policy, or an authoritative signature counter. No assertion can be securely
/// verified against those records.
const AUTHENTICATION_DISABLED: &str = "Passkey authentication is disabled because stored \
registrations lack a server-verified public key and signature counter; delete the legacy \
passkey and re-enroll after cryptographic WebAuthn verification is available";

/// Continuing to accept registration without verifying the attestation would
/// create more records that can never authenticate securely.
const REGISTRATION_DISABLED: &str = "Passkey registration is disabled because this build cannot \
cryptographically verify WebAuthn attestation; no credential was stored";

const PASSKEYS_UNAVAILABLE: &str = "Passkeys are temporarily unavailable because existing credentials lack verifiable registration material. Remove legacy credentials and re-enroll after verified passkey registration is available.";

/// Padding is a serialisation detail rather than a credential difference, so
/// both engines below accept a padded or unpadded spelling of the same bytes.
/// Non-canonical trailing bits stay rejected: such a spelling is not a Base64
/// encoding of the bytes it nearly decodes to.
const ANY_PADDING: GeneralPurposeConfig =
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent);
const URL_SAFE_ANY_PAD: GeneralPurpose = GeneralPurpose::new(&alphabet::URL_SAFE, ANY_PADDING);
const STANDARD_ANY_PAD: GeneralPurpose = GeneralPurpose::new(&alphabet::STANDARD, ANY_PADDING);

/// The Base64 alphabet(s) a credential-id spelling is admissible in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CredentialAlphabet {
    UrlSafe,
    Standard,
    /// Contains no character that distinguishes the alphabets.
    Either,
    /// Mixes characters exclusive to both alphabets; not valid Base64 at all.
    Neither,
}

impl CredentialAlphabet {
    /// Could both spellings have come from one alphabet?
    fn can_share_spelling_with(self, other: Self) -> bool {
        match (self, other) {
            (Self::Neither, _) | (_, Self::Neither) => false,
            (Self::Either, _) | (_, Self::Either) => true,
            (left, right) => left == right,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyStatus {
    pub registration_available: bool,
    pub authentication_available: bool,
    pub legacy_credentials_require_reregistration: bool,
    pub unavailable_reason: &'static str,
}

#[derive(Error, Debug, PartialEq, Eq)]
pub enum PasskeyError {
    #[error("{AUTHENTICATION_DISABLED}")]
    SecureVerificationUnavailable,
    #[error("{REGISTRATION_DISABLED}")]
    SecureRegistrationUnavailable,
    #[error("Passkey credential not found")]
    NotFound,
    #[error("Passkey storage error: {0}")]
    Storage(String),
}

/// Passkey unlock is deliberately fail-closed.
///
/// The previous implementation retained a challenge and then trusted the
/// browser-provided credential ID. That is not WebAuthn verification: it did
/// not validate clientDataJSON type/origin, RP ID hash, UP/UV flags, signature,
/// or the authenticator counter against a registration-derived public key.
///
/// Until verified registration material can be persisted, this manager never
/// creates an unlock token. `get_vault_secret` at the Tauri command boundary
/// still requires such a token, so no stored vault/API secret can be released
/// through the legacy passkey flow.
#[derive(Default)]
pub struct PasskeyManager;

impl PasskeyManager {
    pub fn status(&self) -> PasskeyStatus {
        PasskeyStatus {
            registration_available: false,
            authentication_available: false,
            legacy_credentials_require_reregistration: true,
            unavailable_reason: PASSKEYS_UNAVAILABLE,
        }
    }

    /// Which Base64 alphabet a stored credential-id spelling could have been
    /// written in, inferred from the characters that distinguish the two
    /// standard alphabets.
    fn alphabet_of(value: &str) -> CredentialAlphabet {
        let url_safe = value.contains(['-', '_']);
        let standard = value.contains(['+', '/']);
        match (url_safe, standard) {
            // `-_` and `+/` in one string: no single alphabet spells this.
            (true, true) => CredentialAlphabet::Neither,
            (true, false) => CredentialAlphabet::UrlSafe,
            (false, true) => CredentialAlphabet::Standard,
            // No distinguishing character: both alphabets decode it identically.
            (false, false) => CredentialAlphabet::Either,
        }
    }

    /// Decode a credential id together with the alphabet it was spelled in.
    ///
    /// Padding is accepted or omitted on either side, because legacy records
    /// were written with whichever spelling the browser happened to supply.
    /// The alphabet, unlike the padding, is *not* normalised away: it is
    /// returned so the caller can refuse to compare across alphabets.
    fn decode_credential_id(value: &str) -> Option<(Vec<u8>, CredentialAlphabet)> {
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        let alphabet = Self::alphabet_of(value);
        let decoded = match alphabet {
            CredentialAlphabet::UrlSafe | CredentialAlphabet::Either => {
                URL_SAFE_ANY_PAD.decode(value)
            }
            CredentialAlphabet::Standard => STANDARD_ANY_PAD.decode(value),
            CredentialAlphabet::Neither => return None,
        };
        decoded.ok().map(|bytes| (bytes, alphabet))
    }

    /// Compare two credential ids.
    ///
    /// Matching stays deliberately lenient so that a record written by an older
    /// build is still deletable, but the leniency is bounded to differences
    /// that are *not* semantic: surrounding whitespace, and the presence or
    /// absence of Base64 padding. Two spellings that decode to the same octets
    /// through *different* alphabets are different credentials, and matching
    /// them would let one delete remove another credential's record.
    ///
    /// Restricting this costs nothing for recovery: the delete path is always
    /// reached from `list_passkeys`, which reports the stored spelling verbatim,
    /// so the stored and requested ids agree on alphabet by construction and
    /// usually match as exact strings before any decoding happens.
    fn credential_ids_match(left: &str, right: &str) -> bool {
        let left = left.trim();
        let right = right.trim();
        if left.is_empty() || right.is_empty() {
            return false;
        }
        if left == right {
            return true;
        }
        match (
            Self::decode_credential_id(left),
            Self::decode_credential_id(right),
        ) {
            (Some((left_bytes, left_alphabet)), Some((right_bytes, right_alphabet))) => {
                left_alphabet.can_share_spelling_with(right_alphabet) && left_bytes == right_bytes
            }
            _ => false,
        }
    }

    /// The stored identifier for a record, or `None` when the record carries no
    /// usable one. A present-but-blank `id` counts as unusable: it can never be
    /// matched by a delete, so it must fall through to a synthetic handle.
    fn stored_credential_id(credential: &Value) -> Option<&str> {
        ["id", "rawId"]
            .into_iter()
            .filter_map(|field| credential.get(field).and_then(Value::as_str))
            .map(str::trim)
            .find(|value| !value.is_empty())
    }

    /// Stable handle for a record that has no usable stored identifier, so the
    /// manager can still address it.
    fn synthetic_credential_id(index: usize) -> String {
        format!("legacy_credential_{index}")
    }

    /// Does `requested` address the record at `index`?
    ///
    /// Records with a stored id are matched on that id; records without one are
    /// matched only on the exact synthetic handle `list_passkeys` reported for
    /// them. Synthetic handles are compared literally - they are app-generated
    /// names, not Base64 payloads, so no decoding leniency applies to them.
    fn credential_matches(credential: &Value, index: usize, requested: &str) -> bool {
        match Self::stored_credential_id(credential) {
            Some(stored) => Self::credential_ids_match(stored, requested),
            None => requested.trim() == Self::synthetic_credential_id(index),
        }
    }

    fn storage_key(id: &str) -> String {
        format!("passkeys:{id}")
    }

    pub async fn get_registration_options(
        &self,
        _storage: &Storage,
        _id: &str,
    ) -> Result<Value, PasskeyError> {
        Err(PasskeyError::SecureRegistrationUnavailable)
    }

    pub async fn register_passkey(
        &self,
        _storage: &Storage,
        _id: &str,
        _attestation: Value,
    ) -> Result<(), PasskeyError> {
        Err(PasskeyError::SecureRegistrationUnavailable)
    }

    pub async fn get_auth_options(
        &self,
        _storage: &Storage,
        _id: &str,
    ) -> Result<Value, PasskeyError> {
        Err(PasskeyError::SecureVerificationUnavailable)
    }

    pub async fn authenticate_passkey(
        &self,
        _storage: &Storage,
        _id: &str,
        _assertion: Value,
    ) -> Result<Value, PasskeyError> {
        // Never mint an unlock token from legacy registration material.
        Err(PasskeyError::SecureVerificationUnavailable)
    }

    pub async fn list_passkeys(
        &self,
        storage: &Storage,
        id: &str,
    ) -> Result<Vec<Value>, PasskeyError> {
        let list = storage
            .get_passkeys(id)
            .await
            .map_err(|e| PasskeyError::Storage(e.to_string()))?;

        Ok(list
            .into_iter()
            .enumerate()
            .map(|(index, credential)| {
                serde_json::json!({
                    "id": Self::stored_credential_id(&credential)
                        .map(str::to_string)
                        .unwrap_or_else(|| Self::synthetic_credential_id(index)),
                    "counter": credential
                        .get("counter")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    "requiresReregistration": true,
                })
            })
            .collect())
    }

    pub async fn delete_passkey(
        &self,
        storage: &Storage,
        id: &str,
        credential_id: &str,
    ) -> Result<(), PasskeyError> {
        let list = storage
            .get_passkeys(id)
            .await
            .map_err(|e| PasskeyError::Storage(e.to_string()))?;
        // Indices must be the ones `list_passkeys` reported, so a record shown
        // under a synthetic handle is removable by that handle.
        let list: Vec<Value> = list
            .into_iter()
            .enumerate()
            .filter(|(index, credential)| {
                !Self::credential_matches(credential, *index, credential_id)
            })
            .map(|(_, credential)| credential)
            .collect();

        if list.is_empty() {
            storage
                .delete_secret(&Self::storage_key(id))
                .await
                .map_err(|e| PasskeyError::Storage(e.to_string()))
        } else {
            let json =
                serde_json::to_string(&list).map_err(|e| PasskeyError::Storage(e.to_string()))?;
            storage
                .store_secret(&Self::storage_key(id), &json)
                .await
                .map_err(|e| PasskeyError::Storage(e.to_string()))
        }
    }

    pub async fn verify_token(
        &self,
        _id: &str,
        _token: &str,
        _consume: bool,
    ) -> Result<bool, PasskeyError> {
        // There is intentionally no token store while assertion verification
        // cannot be completed cryptographically.
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "key_passkey";
    const CREDENTIAL_ID: &str = "Y3JlZGVudGlhbC1pZA";

    fn complete_assertion() -> Value {
        let client_data = json!({
            "type": "webauthn.get",
            "challenge": "server-issued-challenge",
            "origin": "http://localhost:3000",
        });
        let mut authenticator_data = vec![0x11; 32];
        authenticator_data.push(0b0000_0101);
        authenticator_data.extend_from_slice(&7_u32.to_be_bytes());

        json!({
            "id": CREDENTIAL_ID,
            "rawId": CREDENTIAL_ID,
            "type": "public-key",
            "response": {
                "clientDataJSON": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(&client_data).expect("client data")),
                "authenticatorData": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(authenticator_data),
                "signature": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(b"signature"),
                "userHandle": null,
            },
            "clientExtensionResults": {},
        })
    }

    async fn assert_authentication_fails_closed(assertion: Value) {
        let storage = Storage::new(false);
        let manager = PasskeyManager;
        let result = manager.authenticate_passkey(&storage, ID, assertion).await;
        assert_eq!(
            result.expect_err("legacy passkey must not authenticate"),
            PasskeyError::SecureVerificationUnavailable
        );
        assert!(!manager
            .verify_token(ID, "any-token", false)
            .await
            .expect("token check"));
    }

    #[tokio::test]
    async fn complete_assertion_path_fails_closed_without_trusted_public_key() {
        assert_authentication_fails_closed(complete_assertion()).await;
    }

    #[tokio::test]
    async fn tampered_challenge_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["response"]["clientDataJSON"] = json!("tampered-challenge");
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_origin_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["response"]["clientDataJSON"] = json!("tampered-origin");
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_rp_id_hash_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["response"]["authenticatorData"] =
            json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0_u8; 37]));
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_authenticator_flags_are_rejected() {
        let mut assertion = complete_assertion();
        let mut data = vec![0x11; 32];
        data.push(0);
        data.extend_from_slice(&7_u32.to_be_bytes());
        assertion["response"]["authenticatorData"] =
            json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data));
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_signature_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["response"]["signature"] = json!("tampered-signature");
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_credential_id_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["id"] = json!("different-credential");
        assertion["rawId"] = json!("different-credential");
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn assertion_replay_is_rejected() {
        let assertion = complete_assertion();
        assert_authentication_fails_closed(assertion.clone()).await;
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn counter_regression_is_rejected() {
        let storage = Storage::new(false);
        storage
            .store_passkey(
                ID,
                json!({
                    "id": CREDENTIAL_ID,
                    "counter": 10,
                    "response": { "attestationObject": "legacy-untrusted-data" },
                }),
            )
            .await
            .expect("legacy record");

        let manager = PasskeyManager;
        let result = manager
            .authenticate_passkey(&storage, ID, complete_assertion())
            .await;
        assert_eq!(
            result.expect_err("counter regression must fail"),
            PasskeyError::SecureVerificationUnavailable
        );
        let options = manager.get_auth_options(&storage, ID).await;
        assert_eq!(
            options.expect_err("legacy options must fail"),
            PasskeyError::SecureVerificationUnavailable
        );
    }

    #[tokio::test]
    async fn registration_is_disabled_instead_of_storing_unverified_material() {
        let storage = Storage::new(false);
        let manager = PasskeyManager;
        assert_eq!(
            manager
                .get_registration_options(&storage, ID)
                .await
                .expect_err("registration options"),
            PasskeyError::SecureRegistrationUnavailable
        );
        assert_eq!(
            manager
                .register_passkey(&storage, ID, json!({"untrusted": true}))
                .await
                .expect_err("registration"),
            PasskeyError::SecureRegistrationUnavailable
        );
        assert!(storage.get_passkeys(ID).await.expect("passkeys").is_empty());
    }

    #[test]
    fn status_reports_fail_closed_capabilities_and_legacy_recovery() {
        assert_eq!(
            PasskeyManager.status(),
            PasskeyStatus {
                registration_available: false,
                authentication_available: false,
                legacy_credentials_require_reregistration: true,
                unavailable_reason: PASSKEYS_UNAVAILABLE,
            }
        );
    }

    #[tokio::test]
    async fn legacy_passkeys_remain_listable_and_deletable_for_recovery() {
        let storage = Storage::new(false);
        let manager = PasskeyManager;
        storage
            .store_passkey(ID, json!({"id": CREDENTIAL_ID, "counter": 4}))
            .await
            .expect("legacy record");

        let list = manager.list_passkeys(&storage, ID).await.expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["requiresReregistration"], true);
        assert_eq!(list[0]["counter"], 4);

        manager
            .delete_passkey(&storage, ID, CREDENTIAL_ID)
            .await
            .expect("delete");
        assert!(manager
            .list_passkeys(&storage, ID)
            .await
            .expect("list after delete")
            .is_empty());
    }

    #[tokio::test]
    async fn token_verification_can_never_authorize_secret_release() {
        let manager = PasskeyManager;
        assert!(!manager
            .verify_token(ID, "attacker-controlled-token", true)
            .await
            .expect("verify token"));
    }
}
