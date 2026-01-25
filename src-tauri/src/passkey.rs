use base64::Engine;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum PasskeyError {
    #[error("Passkey error: {0}")]
    Error(String),
    #[error("Not found")]
    NotFound,
}

pub struct PasskeyManager {
    challenges: Mutex<HashMap<String, String>>,
    credentials: Mutex<HashMap<String, Vec<Value>>>,
}

impl Default for PasskeyManager {
    fn default() -> Self {
        Self {
            challenges: Mutex::new(HashMap::new()),
            credentials: Mutex::new(HashMap::new()),
        }
    }
}

impl PasskeyManager {
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
        let mut credentials = self.credentials.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;

        let cred_list = credentials.entry(id.to_string()).or_insert_with(Vec::new);
        cred_list.push(attestation);

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

        let credentials = self.credentials.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;
        let allow_credentials = credentials
            .get(id)
            .cloned()
            .unwrap_or_default()
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
        let credentials = self.credentials.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;

        if credentials.contains_key(id) {
            if let Some(list) = credentials.get(id) {
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
        let credentials = self.credentials.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;

        Ok(credentials.get(id)
            .cloned()
            .unwrap_or_default()
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
        let mut credentials = self.credentials.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;

        if let Some(cred_list) = credentials.get_mut(id) {
            cred_list.retain(|c| {
                c["id"].as_str() != Some(credential_id)
                    && c["rawId"].as_str() != Some(credential_id)
            });
        }

        Ok(())
    }
}
