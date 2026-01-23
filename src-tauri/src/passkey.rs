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
    pub async fn get_registration_options(&self, id: &str) -> Result<Value, PasskeyError> {
        // Generate a random challenge
        let challenge = base64::engine::general_purpose::STANDARD
            .encode(rand::random::<[u8; 32]>());

        // Store challenge
        let mut challenges = self.challenges.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;
        challenges.insert(id.to_string(), challenge.clone());

        Ok(serde_json::json!({
            "challenge": challenge,
            "options": {
                "rp": { "name": "Better Cloudflare" },
                "user": {
                    "id": id,
                    "name": id,
                    "displayName": id
                },
                "pubKeyCredParams": [
                    { "alg": -7, "type": "public-key" },
                    { "alg": -257, "type": "public-key" }
                ]
            }
        }))
    }

    pub async fn register_passkey(&self, id: &str, attestation: Value) -> Result<(), PasskeyError> {
        // In a full implementation, this would verify the attestation
        // For now, we'll just store the credential
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
        let challenge = base64::engine::general_purpose::STANDARD
            .encode(rand::random::<[u8; 32]>());

        // Store challenge
        let mut challenges = self.challenges.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;
        challenges.insert(id.to_string(), challenge.clone());

        Ok(serde_json::json!({
            "challenge": challenge,
            "options": {
                "allowCredentials": []
            }
        }))
    }

    pub async fn authenticate_passkey(&self, id: &str, _assertion: Value) -> Result<Value, PasskeyError> {
        // In a full implementation, this would verify the assertion
        // For now, we'll just return success
        let credentials = self.credentials.lock()
            .map_err(|e| PasskeyError::Error(e.to_string()))?;

        if credentials.contains_key(id) {
            // Generate a token for vault access
            let token = base64::engine::general_purpose::STANDARD
                .encode(rand::random::<[u8; 32]>());

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
            });
        }

        Ok(())
    }
}
