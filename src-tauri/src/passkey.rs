use base64::Engine;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use thiserror::Error;
use crate::storage::Storage;

#[derive(Error, Debug)]
pub enum PasskeyError {
    #[error("Passkey error: {0}")]
    Error(String),
    #[error("Not found")]
    NotFound,
}

pub struct PasskeyManager {
    challenges: Mutex<HashMap<String, String>>,
    storage: Storage,
}

impl Default for PasskeyManager {
    fn default() -> Self {
        Self {
            challenges: Mutex::new(HashMap::new()),
            storage: Storage::new(true),
        }
    }
}

impl PasskeyManager {
    pub fn new(storage: Storage) -> Self {
        Self {
            challenges: Mutex::new(HashMap::new()),
            storage,
        }
    }

    fn extract_client_challenge(payload: &Value) -> Result<String, PasskeyError> {
        let client_data_b64 = payload
            .get("response")
            .and_then(|v| v.get("clientDataJSON"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| PasskeyError::Error("Missing clientDataJSON".to_string()))?;
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(client_data_b64)
            .or_else(|_| {
                base64::engine::general_purpose::URL_SAFE.decode(client_data_b64)
            })
            .or_else(|_| {
                base64::engine::general_purpose::STANDARD.decode(client_data_b64)
            })
            .map_err(|e| PasskeyError::Error(e.to_string()))?;
        let parsed: Value = serde_json::from_slice(&decoded)
            .map_err(|e| PasskeyError::Error(e.to_string()))?;
        parsed
            .get("challenge")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| PasskeyError::Error("Missing challenge".to_string()))
    }
    pub async fn get_registration_options(&self, id: &str) -> Result<Value, PasskeyError> {
        // Generate a random challenge
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(rand::random::<[u8; 32]>());
        let user_id = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(id.as_bytes());

        // Store challenge
        let mut challenges = self.challenges.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;
        challenges.insert(id.to_string(), challenge.clone());

        Ok(serde_json::json!({
            "challenge": challenge,
            "options": {
                "rp": { "name": "Better Cloudflare", "id": "localhost" },
                "user": {
                    "id": user_id,
                    "name": id,
                    "displayName": id
                },
                "pubKeyCredParams": [
                    { "alg": -7, "type": "public-key" },
                    { "alg": -257, "type": "public-key" }
                ],
                "timeout": 60000,
                "authenticatorSelection": {
                    "userVerification": "preferred"
                }
            }
        }))
    }

    pub async fn register_passkey(&self, id: &str, attestation: Value) -> Result<(), PasskeyError> {
        // In a full implementation, this would verify the attestation
        // For now, we'll just store the credential
        let expected = {
            let challenges = self.challenges.lock()
                .map_err(|e| PasskeyError::Error(e.to_string()))?;
            challenges.get(id).cloned()
        };
        let expected = expected.ok_or(PasskeyError::NotFound)?;
        let challenge = Self::extract_client_challenge(&attestation)?;
        if challenge != expected {
            return Err(PasskeyError::Error("Challenge mismatch".to_string()));
        }
        self.storage
            .store_passkey(id, attestation)
            .await
            .map_err(|e| PasskeyError::Error(e.to_string()))?;

        // Clear the challenge
        let mut challenges = self.challenges.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;
        challenges.remove(id);

        Ok(())
    }

    pub async fn get_auth_options(&self, id: &str) -> Result<Value, PasskeyError> {
        // Generate a random challenge
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(rand::random::<[u8; 32]>());

        // Store challenge
        let mut challenges = self.challenges.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;
        challenges.insert(id.to_string(), challenge.clone());

        let allow_credentials = self
            .storage
            .get_passkeys(id)
            .await
            .map_err(|e| PasskeyError::Error(e.to_string()))?
            .into_iter()
            .filter_map(|c| {
                let cred_id = c["id"].as_str().map(|s| s.to_string())
                    .or_else(|| c["rawId"].as_str().map(|s| s.to_string()));
                cred_id.map(|id| serde_json::json!({ "id": id, "type": "public-key" }))
            })
            .collect::<Vec<_>>();

        Ok(serde_json::json!({
            "challenge": challenge,
            "options": {
                "rpId": "localhost",
                "allowCredentials": allow_credentials,
                "timeout": 60000,
                "userVerification": "preferred"
            }
        }))
    }

    pub async fn authenticate_passkey(&self, id: &str, _assertion: Value) -> Result<Value, PasskeyError> {
        // In a full implementation, this would verify the assertion
        // For now, we'll just return success
        let expected = {
            let challenges = self.challenges.lock()
                .map_err(|e| PasskeyError::Error(e.to_string()))?;
            challenges.get(id).cloned()
        };
        let expected = expected.ok_or(PasskeyError::NotFound)?;
        let challenge = Self::extract_client_challenge(&_assertion)?;
        if challenge != expected {
            return Err(PasskeyError::Error("Challenge mismatch".to_string()));
        }
        let list = self
            .storage
            .get_passkeys(id)
            .await
            .map_err(|e| PasskeyError::Error(e.to_string()))?;
        if !list.is_empty() {
            let assertion_id = _assertion.get("rawId")
                .and_then(|v| v.as_str())
                .or_else(|| _assertion.get("id").and_then(|v| v.as_str()));
            if let Some(assertion_id) = assertion_id {
                let matched = list.iter().any(|c| {
                    c.get("rawId").and_then(|v| v.as_str()) == Some(assertion_id)
                        || c.get("id").and_then(|v| v.as_str()) == Some(assertion_id)
                });
                if !matched {
                    return Err(PasskeyError::NotFound);
                }
            }
            // Generate a token for vault access
            let token = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(rand::random::<[u8; 32]>());

            let mut challenges = self.challenges.lock()
                .map_err(|e| PasskeyError::Error(e.to_string()))?;
            challenges.remove(id);

            Ok(serde_json::json!({
                "success": true,
                "token": token
            }))
        } else {
            Err(PasskeyError::NotFound)
        }
    }

    pub async fn list_passkeys(&self, id: &str) -> Result<Vec<Value>, PasskeyError> {
        let list = self
            .storage
            .get_passkeys(id)
            .await
            .map_err(|e| PasskeyError::Error(e.to_string()))?;

        Ok(list
            .into_iter()
            .enumerate()
            .map(|(i, c)| {
                serde_json::json!({
                    "id": c["id"].as_str().unwrap_or(&format!("cred_{}", i)),
                    "counter": c["counter"].as_u64().unwrap_or(0)
                })
            })
            .collect())
    }

    pub async fn delete_passkey(&self, id: &str, credential_id: &str) -> Result<(), PasskeyError> {
        self.storage
            .delete_passkey(id, credential_id)
            .await
            .map_err(|e| PasskeyError::Error(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    fn encode_client_data(challenge: &str) -> String {
        let payload = serde_json::json!({ "challenge": challenge });
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
    }

    #[tokio::test]
    async fn registration_and_authentication_flow() {
        let mgr = PasskeyManager::new(Storage::new(false));
        let id = "key_1";

        let options = mgr.get_registration_options(id).await.expect("options");
        let challenge = options
            .get("challenge")
            .and_then(|v| v.as_str())
            .expect("challenge");

        let attestation = serde_json::json!({
            "id": "cred_1",
            "rawId": "cred_1_raw",
            "response": {
                "clientDataJSON": encode_client_data(challenge)
            }
        });

        mgr.register_passkey(id, attestation)
            .await
            .expect("register passkey");

        let auth_options = mgr.get_auth_options(id).await.expect("auth opts");
        let auth_challenge = auth_options
            .get("challenge")
            .and_then(|v| v.as_str())
            .expect("auth challenge");
        let allow_creds = auth_options
            .get("options")
            .and_then(|v| v.get("allowCredentials"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert!(allow_creds.iter().any(|c| c.get("id").and_then(|v| v.as_str()) == Some("cred_1")));

        let assertion = serde_json::json!({
            "id": "cred_1",
            "rawId": "cred_1_raw",
            "response": {
                "clientDataJSON": encode_client_data(auth_challenge)
            }
        });

        let result = mgr.authenticate_passkey(id, assertion).await.expect("auth");
        assert!(result.get("success").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(result.get("token").and_then(|v| v.as_str()).is_some());
    }

    #[tokio::test]
    async fn challenge_mismatch_rejected() {
        let mgr = PasskeyManager::new(Storage::new(false));
        let id = "key_2";
        let options = mgr.get_registration_options(id).await.expect("options");
        let challenge = options
            .get("challenge")
            .and_then(|v| v.as_str())
            .expect("challenge");

        let attestation = serde_json::json!({
            "id": "cred_bad",
            "response": {
                "clientDataJSON": encode_client_data(&format!("{challenge}-wrong"))
            }
        });

        let result = mgr.register_passkey(id, attestation).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn list_and_delete_passkeys() {
        let mgr = PasskeyManager::new(Storage::new(false));
        let id = "key_3";
        let options = mgr.get_registration_options(id).await.expect("options");
        let challenge = options
            .get("challenge")
            .and_then(|v| v.as_str())
            .expect("challenge");
        let attestation = serde_json::json!({
            "id": "cred_list",
            "response": {
                "clientDataJSON": encode_client_data(challenge)
            }
        });
        mgr.register_passkey(id, attestation)
            .await
            .expect("register passkey");

        let list = mgr.list_passkeys(id).await.expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].get("id").and_then(|v| v.as_str()), Some("cred_list"));

        mgr.delete_passkey(id, "cred_list").await.expect("delete");
        let list = mgr.list_passkeys(id).await.expect("list after delete");
        assert!(list.is_empty());
    }
}
