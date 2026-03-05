//! OpenAI (and OpenAI-compatible) provider implementation.
//!
//! Supports GPT-4o, o1, o3, and any OpenAI-compatible endpoint (Groq,
//! Together AI, vLLM, etc.) by overriding `base_url` in the config.

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::config::ProviderConfig;
use crate::error::AiProviderError;
use crate::traits::AiProvider;
use crate::types::*;

/// OpenAI provider client.
pub struct OpenAiProvider {
    client: Client,
    config: ProviderConfig,
}

impl OpenAiProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, AiProviderError> {
        let api_key = config.api_key.as_deref().unwrap_or_default();
        if api_key.is_empty() {
            return Err(AiProviderError::NotConfigured(
                "OpenAI API key is required".into(),
            ));
        }
        Ok(Self {
            client: Client::new(),
            config,
        })
    }

    /// Shared reqwest client variant (connection pooling).
    pub fn with_client(client: Client, config: ProviderConfig) -> Result<Self, AiProviderError> {
        let api_key = config.api_key.as_deref().unwrap_or_default();
        if api_key.is_empty() {
            return Err(AiProviderError::NotConfigured(
                "OpenAI API key is required".into(),
            ));
        }
        Ok(Self { client, config })
    }

    fn base_url(&self) -> &str {
        self.config.effective_base_url()
    }

    fn auth_header(&self) -> String {
        format!(
            "Bearer {}",
            self.config.api_key.as_deref().unwrap_or_default()
        )
    }

    /// Convert our messages to the OpenAI wire format.
    fn build_messages(system: Option<&str>, messages: &[Message]) -> Vec<Value> {
        let mut out = Vec::new();
        if let Some(sys) = system {
            out.push(json!({"role": "system", "content": sys}));
        }
        for msg in messages {
            match &msg.content {
                MessageContent::Text { text } => {
                    let role = match msg.role {
                        Role::System => "system",
                        Role::User => "user",
                        Role::Assistant => "assistant",
                        Role::Tool => "tool",
                    };
                    let mut m = json!({"role": role, "content": text});
                    if let Some(id) = &msg.tool_call_id {
                        m["tool_call_id"] = json!(id);
                    }
                    out.push(m);
                }
                MessageContent::ToolUse { tool_calls } => {
                    let calls: Vec<Value> = tool_calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": tc.arguments.to_string(),
                                }
                            })
                        })
                        .collect();
                    out.push(json!({"role": "assistant", "tool_calls": calls}));
                }
                MessageContent::ToolResult {
                    tool_call_id,
                    content,
                    ..
                } => {
                    out.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": content,
                    }));
                }
            }
        }
        out
    }

    /// Convert our tool definitions to the OpenAI format.
    fn build_tools(tools: &[ToolDefinition]) -> Vec<Value> {
        tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect()
    }

    fn parse_response(&self, body: Value) -> Result<CompletionResponse, AiProviderError> {
        let choice = body["choices"]
            .get(0)
            .ok_or_else(|| AiProviderError::Parse("No choices in response".into()))?;

        let msg = &choice["message"];
        let finish_reason = choice["finish_reason"].as_str().map(String::from);

        let message = if let Some(tool_calls) = msg["tool_calls"].as_array() {
            let calls: Vec<ToolCall> = tool_calls
                .iter()
                .filter_map(|tc| {
                    let id = tc["id"].as_str()?;
                    let name = tc["function"]["name"].as_str()?;
                    let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
                    let arguments = serde_json::from_str(args_str).unwrap_or(json!({}));
                    Some(ToolCall {
                        id: id.to_string(),
                        name: name.to_string(),
                        arguments,
                    })
                })
                .collect();
            Message {
                role: Role::Assistant,
                content: MessageContent::ToolUse { tool_calls: calls },
                tool_call_id: None,
            }
        } else {
            let text = msg["content"].as_str().unwrap_or("").to_string();
            Message::assistant(text)
        };

        let usage = body.get("usage").map(|u| Usage {
            prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
            completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0) as u32,
            total_tokens: u["total_tokens"].as_u64().unwrap_or(0) as u32,
        });

        let model = body["model"].as_str().unwrap_or(&self.config.model).to_string();

        Ok(CompletionResponse {
            message,
            usage,
            model,
            finish_reason,
        })
    }
}

/// OpenAI models list response.
#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

/// OpenAI API error response body.
#[derive(Deserialize)]
struct ApiErrorBody {
    error: Option<ApiErrorDetail>,
}

#[derive(Deserialize)]
struct ApiErrorDetail {
    message: Option<String>,
    code: Option<String>,
}

#[async_trait]
impl AiProvider for OpenAiProvider {
    fn kind(&self) -> &str {
        "openai"
    }

    async fn complete(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, AiProviderError> {
        let url = format!("{}/chat/completions", self.base_url());

        let mut body = json!({
            "model": request.model,
            "messages": Self::build_messages(request.system.as_deref(), &request.messages),
        });
        if let Some(temp) = request.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(max) = request.max_tokens {
            body["max_tokens"] = json!(max);
        }
        if let Some(ref tools) = request.tools {
            if !tools.is_empty() {
                body["tools"] = json!(Self::build_tools(tools));
            }
        }

        let resp = self
            .client
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let status_code = status.as_u16();
            let text = resp.text().await.unwrap_or_default();
            let parsed: ApiErrorBody = serde_json::from_str(&text).unwrap_or(ApiErrorBody { error: None });
            let message = parsed
                .error
                .as_ref()
                .and_then(|e| e.message.clone())
                .unwrap_or(text);
            let provider_code = parsed.error.and_then(|e| e.code);

            if status_code == 429 {
                return Err(AiProviderError::RateLimited {
                    retry_after_ms: None,
                });
            }
            if status_code == 401 {
                return Err(AiProviderError::AuthFailed(message));
            }
            return Err(AiProviderError::Api {
                status: status_code,
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
        let url = format!("{}/chat/completions", self.base_url());

        let mut body = json!({
            "model": request.model,
            "messages": Self::build_messages(request.system.as_deref(), &request.messages),
            "stream": true,
        });
        if let Some(temp) = request.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(max) = request.max_tokens {
            body["max_tokens"] = json!(max);
        }
        if let Some(ref tools) = request.tools {
            if !tools.is_empty() {
                body["tools"] = json!(Self::build_tools(tools));
            }
        }

        let resp = self
            .client
            .post(&url)
            .header("Authorization", self.auth_header())
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

        // Process SSE stream
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();

        use futures::StreamExt;
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(AiProviderError::Http)?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || line == "data: [DONE]" {
                    if line == "data: [DONE]" {
                        let _ = tx.send(StreamDelta::Done).await;
                    }
                    continue;
                }
                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(chunk_json) = serde_json::from_str::<Value>(data) {
                        if let Some(choice) = chunk_json["choices"].get(0) {
                            let delta = &choice["delta"];

                            // Text delta
                            if let Some(text) = delta["content"].as_str() {
                                full_text.push_str(text);
                                let _ = tx
                                    .send(StreamDelta::Text {
                                        text: text.to_string(),
                                    })
                                    .await;
                            }

                            // Tool call deltas
                            if let Some(tcs) = delta["tool_calls"].as_array() {
                                for tc in tcs {
                                    let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                                    if let Some(func) = tc.get("function") {
                                        if let Some(name) = func["name"].as_str() {
                                            let id = tc["id"]
                                                .as_str()
                                                .unwrap_or_default()
                                                .to_string();
                                            // Expand tool_calls vec
                                            while tool_calls.len() <= idx {
                                                tool_calls.push(ToolCall {
                                                    id: String::new(),
                                                    name: String::new(),
                                                    arguments: json!({}),
                                                });
                                            }
                                            tool_calls[idx].id = id.clone();
                                            tool_calls[idx].name = name.to_string();
                                            let _ = tx
                                                .send(StreamDelta::ToolCallStart {
                                                    id,
                                                    name: name.to_string(),
                                                })
                                                .await;
                                        }
                                        if let Some(args) = func["arguments"].as_str() {
                                            while tool_calls.len() <= idx {
                                                tool_calls.push(ToolCall {
                                                    id: String::new(),
                                                    name: String::new(),
                                                    arguments: json!({}),
                                                });
                                            }
                                            let _ = tx
                                                .send(StreamDelta::ToolCallDelta {
                                                    id: tool_calls[idx].id.clone(),
                                                    arguments: args.to_string(),
                                                })
                                                .await;
                                        }
                                    }
                                }
                            }

                            // Finish reason
                            if let Some(fr) = choice["finish_reason"].as_str() {
                                finish_reason = Some(fr.to_string());
                            }
                        }

                        // Usage (in some APIs sent at the end)
                        if let Some(u) = chunk_json.get("usage") {
                            let u = Usage {
                                prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
                                completion_tokens: u["completion_tokens"]
                                    .as_u64()
                                    .unwrap_or(0)
                                    as u32,
                                total_tokens: u["total_tokens"].as_u64().unwrap_or(0) as u32,
                            };
                            let _ = tx.send(StreamDelta::Usage(u.clone())).await;
                            usage = Some(u);
                        }
                    }
                }
            }
        }

        // Finalize tool call arguments from accumulated string deltas
        for tc in &mut tool_calls {
            let _ = tx
                .send(StreamDelta::ToolCallEnd { id: tc.id.clone() })
                .await;
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
        let url = format!("{}/models", self.base_url());
        let resp = self
            .client
            .get(&url)
            .header("Authorization", self.auth_header())
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

        let body: ModelsResponse = resp.json().await.map_err(|e| AiProviderError::Parse(e.to_string()))?;
        let models = body
            .data
            .into_iter()
            .filter(|m| m.id.starts_with("gpt-") || m.id.starts_with("o1") || m.id.starts_with("o3"))
            .map(|m| {
                let supports_tools = !m.id.contains("instruct");
                Model {
                    name: m.id.clone(),
                    id: m.id,
                    context_window: None,
                    supports_tools,
                    supports_streaming: true,
                }
            })
            .collect();
        Ok(models)
    }

    async fn health_check(&self) -> Result<(), AiProviderError> {
        let url = format!("{}/models", self.base_url());
        let resp = self
            .client
            .get(&url)
            .header("Authorization", self.auth_header())
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
