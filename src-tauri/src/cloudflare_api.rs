use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum CloudflareError {
    #[error("HTTP error: {0}")]
    HttpError(String),
    #[error("API error: {0}")]
    ApiError(String),
    #[error("Authentication failed")]
    AuthFailed,
}

pub struct CloudflareClient {
    client: Client,
    api_key: String,
    email: Option<String>,
}

impl CloudflareClient {
    pub fn new(api_key: &str, email: Option<&str>) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.to_string(),
            email: email.map(|s| s.to_string()),
        }
    }

    pub async fn verify_token(&self) -> Result<bool, CloudflareError> {
        let url = "https://api.cloudflare.com/client/v4/user/tokens/verify";
        
        let mut req = self.client.get(url)
            .header("Authorization", format!("Bearer {}", self.api_key));

        if let Some(email) = &self.email {
            req = req.header("X-Auth-Email", email);
        }

        let response = req.send().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        Ok(response.status().is_success())
    }

    pub async fn get_zones(&self) -> Result<Vec<crate::commands::Zone>, CloudflareError> {
        let url = "https://api.cloudflare.com/client/v4/zones";
        
        let mut req = self.client.get(url)
            .header("Authorization", format!("Bearer {}", self.api_key));

        if let Some(email) = &self.email {
            req = req.header("X-Auth-Email", email);
        }

        let response = req.send().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response.json().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let zones = json["result"].as_array()
            .ok_or(CloudflareError::ApiError("Invalid response format".to_string()))?
            .iter()
            .filter_map(|z| {
                Some(crate::commands::Zone {
                    id: z["id"].as_str()?.to_string(),
                    name: z["name"].as_str()?.to_string(),
                    status: z["status"].as_str().unwrap_or("unknown").to_string(),
                    paused: z["paused"].as_bool().unwrap_or(false),
                    r#type: z["type"].as_str().unwrap_or("").to_string(),
                    development_mode: z["development_mode"]
                        .as_u64()
                        .unwrap_or(0) as u32,
                })
            })
            .collect();

        Ok(zones)
    }

    pub async fn get_dns_records(
        &self,
        zone_id: &str,
    ) -> Result<Vec<crate::commands::DNSRecord>, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/dns_records", zone_id);
        
        let mut req = self.client.get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key));

        if let Some(email) = &self.email {
            req = req.header("X-Auth-Email", email);
        }

        let response = req.send().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response.json().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let records = json["result"].as_array()
            .ok_or(CloudflareError::ApiError("Invalid response format".to_string()))?
            .iter()
            .filter_map(parse_dns_record)
            .collect();

        Ok(records)
    }

    pub async fn create_dns_record(
        &self,
        zone_id: &str,
        record: crate::commands::DNSRecordInput,
    ) -> Result<crate::commands::DNSRecord, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/dns_records", zone_id);
        
        let mut req = self.client.post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&record);

        if let Some(email) = &self.email {
            req = req.header("X-Auth-Email", email);
        }

        let response = req.send().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response.json().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let result = &json["result"];
        parse_dns_record(result).ok_or_else(|| {
            CloudflareError::ApiError("Invalid response format".to_string())
        })
    }

    pub async fn update_dns_record(
        &self,
        zone_id: &str,
        record_id: &str,
        record: crate::commands::DNSRecordInput,
    ) -> Result<crate::commands::DNSRecord, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/dns_records/{}", zone_id, record_id);
        
        let mut req = self.client.put(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&record);

        if let Some(email) = &self.email {
            req = req.header("X-Auth-Email", email);
        }

        let response = req.send().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response.json().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let result = &json["result"];
        parse_dns_record(result).ok_or_else(|| {
            CloudflareError::ApiError("Invalid response format".to_string())
        })
    }

    pub async fn delete_dns_record(&self, zone_id: &str, record_id: &str) -> Result<(), CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/dns_records/{}", zone_id, record_id);
        
        let mut req = self.client.delete(&url)
            .header("Authorization", format!("Bearer {}", self.api_key));

        if let Some(email) = &self.email {
            req = req.header("X-Auth-Email", email);
        }

        let response = req.send().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        Ok(())
    }

    pub async fn create_bulk_dns_records(
        &self,
        zone_id: &str,
        records: Vec<crate::commands::DNSRecordInput>,
    ) -> Result<Value, CloudflareError> {
        let mut created = Vec::new();
        let mut skipped = Vec::new();

        for (idx, record) in records.into_iter().enumerate() {
            match self.create_dns_record(zone_id, record).await {
                Ok(rec) => created.push(rec),
                Err(e) => skipped.push(serde_json::json!({
                    "index": idx,
                    "error": e.to_string()
                })),
            }
        }

        Ok(serde_json::json!({
            "created": created,
            "skipped": skipped
        }))
    }

    pub async fn export_dns_records(&self, zone_id: &str, format: &str) -> Result<String, CloudflareError> {
        let records = self.get_dns_records(zone_id).await?;

        match format {
            "json" => serde_json::to_string_pretty(&records)
                .map_err(|e| CloudflareError::ApiError(e.to_string())),
            "csv" => {
                let mut csv = "Type,Name,Content,TTL,Priority,Proxied\n".to_string();
                for record in records {
                    csv.push_str(&format!(
                        "{},{},{},{},{},{}\n",
                        record.r#type,
                        record.name,
                        record.content,
                        record.ttl.unwrap_or(1),
                        record.priority.unwrap_or(0),
                        record.proxied.unwrap_or(false)
                    ));
                }
                Ok(csv)
            }
            _ => Err(CloudflareError::ApiError("Unsupported format".to_string())),
        }
    }
}

fn parse_dns_record(value: &Value) -> Option<crate::commands::DNSRecord> {
    Some(crate::commands::DNSRecord {
        id: value["id"].as_str().map(|s| s.to_string()),
        r#type: value["type"].as_str()?.to_string(),
        name: value["name"].as_str()?.to_string(),
        content: value["content"].as_str()?.to_string(),
        ttl: value["ttl"].as_u64().map(|n| n as u32),
        priority: value["priority"].as_u64().map(|n| n as u16),
        proxied: value["proxied"].as_bool(),
        zone_id: value["zone_id"].as_str().unwrap_or("").to_string(),
        zone_name: value["zone_name"].as_str().unwrap_or("").to_string(),
        created_on: value["created_on"].as_str().unwrap_or("").to_string(),
        modified_on: value["modified_on"].as_str().unwrap_or("").to_string(),
    })
}
