use reqwest::Client;
use serde_json::Value;
use thiserror::Error;
use serde_json::json;

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

    fn apply_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(email) = &self.email {
            req.header("X-Auth-Email", email)
                .header("X-Auth-Key", &self.api_key)
        } else {
            req.header("Authorization", format!("Bearer {}", self.api_key))
        }
    }

    pub async fn verify_token(&self) -> Result<bool, CloudflareError> {
        let url = if self.email.is_some() {
            "https://api.cloudflare.com/client/v4/user"
        } else {
            "https://api.cloudflare.com/client/v4/user/tokens/verify"
        };

        let req = self.apply_auth(self.client.get(url));
        let response = req.send().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        Ok(response.status().is_success())
    }

    pub async fn get_zones(&self) -> Result<Vec<crate::commands::Zone>, CloudflareError> {
        let url = "https://api.cloudflare.com/client/v4/zones";
        let req = self.apply_auth(self.client.get(url));
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
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<Vec<crate::commands::DNSRecord>, CloudflareError> {
        let mut url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_records",
            zone_id
        );
        let mut params = Vec::new();
        if let Some(page) = page {
            params.push(format!("page={}", page));
        }
        if let Some(per_page) = per_page {
            params.push(format!("per_page={}", per_page));
        }
        if !params.is_empty() {
            url.push('?');
            url.push_str(&params.join("&"));
        }
        
        let mut req = self.client.get(&url)
            ;
        let req = self.apply_auth(req);
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
        
        let req = self.apply_auth(self.client.post(&url).json(&record));
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
        
        let req = self.apply_auth(self.client.put(&url).json(&record));
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
        
        let req = self.apply_auth(self.client.delete(&url));
        let response = req.send().await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        Ok(())
    }

    pub async fn create_bulk_dns_records(
        &self,
        zone_id: &str,
        records: Vec<crate::commands::DNSRecordInput>,
        dryrun: bool,
    ) -> Result<Value, CloudflareError> {
        if dryrun {
            let created = records
                .into_iter()
                .map(|record| {
                    serde_json::json!({
                        "type": record.r#type,
                        "name": record.name,
                        "content": record.content,
                        "comment": record.comment,
                        "ttl": record.ttl,
                        "priority": record.priority,
                        "proxied": record.proxied
                    })
                })
                .collect::<Vec<_>>();
            return Ok(serde_json::json!({
                "created": created,
                "skipped": []
            }));
        }
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

    pub async fn export_dns_records(
        &self,
        zone_id: &str,
        format: &str,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<String, CloudflareError> {
        let records = self.get_dns_records(zone_id, page, per_page).await?;

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
            "bind" => {
                let mut bind = String::new();
                for record in records {
                    let ttl = record.ttl.unwrap_or(1);
                    let ttl = if ttl == 1 { 300 } else { ttl };
                    let priority = record
                        .priority
                        .map(|p| format!("{} ", p))
                        .unwrap_or_default();
                    bind.push_str(&format!(
                        "{}\t{}\tIN\t{}\t{}{}\n",
                        record.name,
                        ttl,
                        record.r#type,
                        priority,
                        record.content
                    ));
                }
                Ok(bind)
            }
            _ => Err(CloudflareError::ApiError("Unsupported format".to_string())),
        }
    }

    pub async fn purge_cache(
        &self,
        zone_id: &str,
        purge_everything: bool,
        files: Option<Vec<String>>,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/purge_cache",
            zone_id
        );
        let body = if purge_everything {
            json!({ "purge_everything": true })
        } else {
            json!({ "files": files.unwrap_or_default() })
        };

        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to purge cache");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    pub async fn get_zone_setting(
        &self,
        zone_id: &str,
        setting_id: &str,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/settings/{}",
            zone_id, setting_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to get zone setting");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    pub async fn update_zone_setting(
        &self,
        zone_id: &str,
        setting_id: &str,
        value: Value,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/settings/{}",
            zone_id, setting_id
        );
        let body = json!({ "value": value });
        let req = self.apply_auth(self.client.patch(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to update zone setting");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }
}

fn parse_dns_record(value: &Value) -> Option<crate::commands::DNSRecord> {
    Some(crate::commands::DNSRecord {
        id: value["id"].as_str().map(|s| s.to_string()),
        r#type: value["type"].as_str()?.to_string(),
        name: value["name"].as_str()?.to_string(),
        content: value["content"].as_str()?.to_string(),
        comment: value["comment"].as_str().map(|s| s.to_string()),
        ttl: value["ttl"].as_u64().map(|n| n as u32),
        priority: value["priority"].as_u64().map(|n| n as u16),
        proxied: value["proxied"].as_bool(),
        zone_id: value["zone_id"].as_str().unwrap_or("").to_string(),
        zone_name: value["zone_name"].as_str().unwrap_or("").to_string(),
        created_on: value["created_on"].as_str().unwrap_or("").to_string(),
        modified_on: value["modified_on"].as_str().unwrap_or("").to_string(),
    })
}
