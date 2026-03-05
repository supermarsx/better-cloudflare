//! Anthropic Claude provider implementation.
//!
//! Supports Claude 4 Opus, Claude Sonnet 4, etc. via the Anthropic Messages API.

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::config::ProviderConfig;
use crate::error::AiProviderError;
use crate::traits::AiProvider;
use crate::types::*;

const ANTHROPIC_API_VERSION: &str = "2023-06-01";

/// Anthropic Claude provider client.
pub struct AnthropicProvider {
    client: Client,
    config: ProviderConfig,
}

impl AnthropicProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, AiProviderError> {
        let api_key = config.api_key.as_deref().unwrap_or_default();
        if api_key.is_empty() {
            return Err(AiProviderError::NotConfigured(
                "Anthropic API key is required".into(),
            ));
        }
        Ok(Self {
            client: Client::new(),
            config,
        })
    }

    pub fn with_client(client: Client, config: ProviderConfig) -> Result<Self, AiProviderError> {
        let api_key = config.api_key.as_deref().unwrap_or_default();
        if api_key.is_empty() {
            return Err(AiProviderError::NotConfigured(
                "Anthropic API key is required".into(),
            ));
        }
        Ok(Self { client, config })
    }

    fn base_url(&self) -> &str {
        self.config.effective_base_url()
    }

    /// Build the Anthropic messages-format body.
    fn build_body(&self, request: &CompletionRequest) -> Value {
        let messages: Vec<Value> = request
            .messages
            .iter()
            .filter(|m| m.role != Role::System)
            .map(|msg| match &msg.content {
                MessageContent::Text { text } => {
                    let role = match msg.role {
                        Role::User | Role::System => "user",
                        Role::Assistant => "assistant",
                        Role::Tool => "user",
                    };
                    json!({"role": role, "content": text})
                }
                MessageContent::ToolUse { tool_calls } => {
                    let content: Vec<Value> = tool_calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "type": "tool_use",
                                "id": tc.id,
                                "name": tc.name,
                                "input": tc.arguments,
                            })
                        })
                        .collect();
                    json!({"role": "assistant", "content": content})
                }
                MessageContent::ToolResult {
                    tool_call_id,
                    content,
                    is_error,
                } => {
                    json!({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": tool_call_id,
                            "content": content,
                            "is_error": is_error,
                        }]
                    })
                }
            })
            .collect();

        let mut body = json!({
            "model": request.model,
            "messages": messages,
            "max_tokens": request.max_tokens.unwrap_or(self.config.max_tokens),
        });

        // System message
        let sys = request
            .system
            .as_deref()
            .or_else(|| {
                request
                    .messages
                    .iter()
                    .find(|m| m.role == Role::System)
                    .map(|m| m.content.as_text())
            });
        if let Some(system_text) = sys {
            body["system"] = json!(system_text);
        }

        if let Some(temp) = request.temperature {
            body["temperature"] = json!(temp);
        }

        // Tools
        if let Some(ref tools) = request.tools {
            if !tools.is_empty() {
                let tool_defs: Vec<Value> = tools
                    .iter()
                    .map(|t| {
                        json!({
                            "name": t.name,
                            "description": t.description,
                            "input_schema": t.input_schema,
                        })
                    })
                    .collect();
                body["tools"] = json!(tool_defs);
            }
        }

        body
    }

    fn parse_response(&self, body: Value) -> Result<CompletionResponse, AiProviderError> {
        let content = body["content"]
            .as_array()
            .ok_or_else(|| AiProviderError::Parse("No content in response".into()))?;

        let mut text_parts = Vec::new();
        let mut tool_calls = Vec::new();

        for block in content {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(t) = block["text"].as_str() {
                        text_parts.push(t.to_string());
                    }
                }
                Some("tool_use") => {
                    if let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str())
                    {
                        tool_calls.push(ToolCall {
                            id: id.to_string(),
                            name: name.to_string(),
                            arguments: block["input"].clone(),
                        });
                    }
                }
                _ => {}
            }
        }

        let message = if !tool_calls.is_empty() {
            Message {
                role: Role::Assistant,
                content: MessageContent::ToolUse { tool_calls },
                tool_call_id: None,
            }
        } else {
            Message::assistant(text_parts.join(""))
        };

        let usage = body.get("usage").map(|u| Usage {
            prompt_tokens: u["input_tokens"].as_u64().unwrap_or(0) as u32,
            completion_tokens: u["output_tokens"].as_u64().unwrap_or(0) as u32,
            total_tokens: (u["input_tokens"].as_u64().unwrap_or(0)
                + u["output_tokens"].as_u64().unwrap_or(0)) as u32,
        });

        let model = body["model"]
            .as_str()
            .unwrap_or(&self.config.model)
            .to_string();
        let finish_reason = body["stop_reason"].as_str().map(String::from);

        Ok(CompletionResponse {
            message,
            usage,
            model,
            finish_reason,
        })
    }
}

#[derive(Deserialize)]
struct ApiError {
    error: Option<ApiErrorDetail>,
}

#[derive(Deserialize)]
struct ApiErrorDetail {
    message: Option<String>,
    #[serde(rename = "type")]
    error_type: Option<String>,
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    fn kind(&self) -> &str {
        "anthropic"
    }

    async fn complete(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, AiProviderError> {
        let url = format!("{}/messages", self.base_url());
        let body = self.build_body(&request);

        let resp = self
            .client
            .post(&url)
            .header("x-api-key", self.config.api_key.as_deref().unwrap_or_default())
            .header("anthropic-version", ANTHROPIC_API_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let code = status.as_u16();
            let text = resp.text().await.unwrap_or_default();
            let parsed: ApiError = serde_json::from_str(&text).unwrap_or(ApiError { error: None });
            let message = parsed.error.as_ref().and_then(|e| e.message.clone()).unwrap_or(text);
            let provider_code = parsed.error.and_then(|e| e.error_type);

            if code == 429 {
                return Err(AiProviderError::RateLimited { retry_after_ms: None });
            }
            if code == 401 {
                return Err(AiProviderError::AuthFailed(message));
            }
            return Err(AiProviderError::Api {
                status: code,
                message,
                provider_code,
            });
        }

        let json_body: Value = resp.json().await?;
        self.parse_response(json_body)
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        tx: mpsc::Sender<StreamDelta>,
    ) -> Result<CompletionResponse, AiProviderError> {
        let url = format!("{}/messages", self.base_url());
        let mut body = self.build_body(&request);
        body["stream"] = json!(true);

        let resp = self
            .client
            .post(&url)
            .header("x-api-key", self.config.api_key.as_deref().unwrap_or_default())
            .header("anthropic-version", ANTHROPIC_API_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            return Err(AiProviderError::Api {
                status,
                message: text,
                provider_code: None,
            });
        }

        let mut full_text = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut usage = None;
        let mut finish_reason = None;
        let model = request.model.clone();

        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();

        use futures::StreamExt;
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(AiProviderError::Http)?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() {
                    continue;
                }
                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(event) = serde_json::from_str::<Value>(data) {
                        match event["type"].as_str() {
                            Some("content_block_start") => {
                                let block = &event["content_block"];
                                if block["type"].as_str() == Some("tool_use") {
                                    let id = block["id"].as_str().unwrap_or_default().to_string();
                                    let name = block["name"].as_str().unwrap_or_default().to_string();
                                    tool_calls.push(ToolCall {
                                        id: id.clone(),
                                        name: name.clone(),
                                        arguments: json!({}),
                                    });
                                    let _ = tx
                                        .send(StreamDelta::ToolCallStart { id, name })
                                        .await;
                                }
                            }
                            Some("content_block_delta") => {
                                let delta = &event["delta"];
                                match delta["type"].as_str() {
                                    Some("text_delta") => {
                                        if let Some(text) = delta["text"].as_str() {
                                            full_text.push_str(text);
                                            let _ = tx
                                                .send(StreamDelta::Text {
                                                    text: text.to_string(),
                                                })
                                                .await;
                                        }
                                    }
                                    Some("input_json_delta") => {
                                        if let Some(partial) = delta["partial_json"].as_str() {
                                            if let Some(tc) = tool_calls.last() {
                                                let _ = tx
                                                    .send(StreamDelta::ToolCallDelta {
                                                        id: tc.id.clone(),
                                                        arguments: partial.to_string(),
                                                    })
                                                    .await;
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            Some("content_block_stop") => {
                                if let Some(tc) = tool_calls.last() {
                                    let _ = tx
                                        .send(StreamDelta::ToolCallEnd { id: tc.id.clone() })
                                        .await;
                                }
                            }
                            Some("message_delta") => {
                                if let Some(fr) = event["delta"]["stop_reason"].as_str() {
                                    finish_reason = Some(fr.to_string());
                                }
                                if let Some(u) = event.get("usage") {
                                    let delta_output = u["output_tokens"].as_u64().unwrap_or(0) as u32;
                                    usage = Some(Usage {
                                        prompt_tokens: 0,
                                        completion_tokens: delta_output,
                                        total_tokens: delta_output,
                                    });
                                }
                            }
                            Some("message_start") => {
                                if let Some(u) = event["message"].get("usage") {
                                    usage = Some(Usage {
                                        prompt_tokens: u["input_tokens"].as_u64().unwrap_or(0)
                                            as u32,
                                        completion_tokens: u["output_tokens"]
                                            .as_u64()
                                            .unwrap_or(0)
                                            as u32,
                                        total_tokens: (u["input_tokens"].as_u64().unwrap_or(0)
                                            + u["output_tokens"].as_u64().unwrap_or(0))
                                            as u32,
                                    });
                                }
                            }
                            Some("message_stop") => {
                                let _ = tx.send(StreamDelta::Done).await;
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        if let Some(ref u) = usage {
            let _ = tx.send(StreamDelta::Usage(u.clone())).await;
        }

        let message = if !tool_calls.is_empty() {
            Message {
                role: Role::Assistant,
                content: MessageContent::ToolUse { tool_calls },
                tool_call_id: None,
            }
        } else {
            Message::assistant(full_text)
        };

        Ok(CompletionResponse {
            message,
            usage,
            model,
            finish_reason,
        })
    }

    async fn list_models(&self) -> Result<Vec<Model>, AiProviderError> {
        // Anthropic does not have a models list endpoint — return curated list
        Ok(vec![
            Model {
                id: "claude-opus-4-20250514".into(),
                name: "Claude Opus 4".into(),
                context_window: Some(200_000),
                supports_tools: true,
                supports_streaming: true,
            },
            Model {
                id: "claude-sonnet-4-20250514".into(),
                name: "Claude Sonnet 4".into(),
                context_window: Some(200_000),
                supports_tools: true,
                supports_streaming: true,
            },
            Model {
                id: "claude-3-5-haiku-20241022".into(),
                name: "Claude 3.5 Haiku".into(),
                context_window: Some(200_000),
                supports_tools: true,
                supports_streaming: true,
            },
        ])
    }

    async fn health_check(&self) -> Result<(), AiProviderError> {
        // Light models list to verify auth
        let url = format!("{}/messages", self.base_url());
        let body = json!({
            "model": "claude-3-5-haiku-20241022",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}],
        });
        let resp = self
            .client
            .post(&url)
            .header("x-api-key", self.config.api_key.as_deref().unwrap_or_default())
            .header("anthropic-version", ANTHROPIC_API_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else if resp.status().as_u16() == 401 {
            Err(AiProviderError::AuthFailed("Invalid API key".into()))
        } else {
            Err(AiProviderError::Api {
                status: resp.status().as_u16(),
                message: "Health check failed".into(),
                provider_code: None,
            })
        }
    }
}
