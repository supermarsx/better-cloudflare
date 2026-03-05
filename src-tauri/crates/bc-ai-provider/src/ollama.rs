//! Ollama local model provider implementation.
//!
//! Connects to a locally-running Ollama instance (`http://localhost:11434`).
//! No authentication required; uses NDJSON streaming.

use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::config::ProviderConfig;
use crate::error::AiProviderError;
use crate::traits::AiProvider;
use crate::types::*;

/// Ollama local LLM provider.
pub struct OllamaProvider {
    client: Client,
    config: ProviderConfig,
}

impl OllamaProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            client: Client::new(),
            config,
        }
    }

    pub fn with_client(client: Client, config: ProviderConfig) -> Self {
        Self { client, config }
    }

    fn base_url(&self) -> &str {
        self.config.effective_base_url()
    }

    fn build_messages(&self, request: &CompletionRequest) -> Vec<Value> {
        let mut messages = Vec::new();

        // System prompt
        if let Some(ref system) = request.system {
            messages.push(json!({"role": "system", "content": system}));
        }

        for msg in &request.messages {
            if msg.role == Role::System {
                messages.push(json!({"role": "system", "content": msg.content.as_text()}));
                continue;
            }
            let role = match msg.role {
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::Tool => "tool",
                Role::System => "system",
            };
            match &msg.content {
                MessageContent::Text { text } => {
                    messages.push(json!({"role": role, "content": text}));
                }
                MessageContent::ToolUse { tool_calls } => {
                    for tc in tool_calls {
                        messages.push(json!({
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [{
                                "function": {
                                    "name": tc.name,
                                    "arguments": tc.arguments,
                                }
                            }]
                        }));
                    }
                }
                MessageContent::ToolResult { content, .. } => {
                    messages.push(json!({"role": "tool", "content": content}));
                }
            }
        }

        messages
    }

    fn build_tools(&self, request: &CompletionRequest) -> Option<Vec<Value>> {
        request.tools.as_ref().map(|tools| {
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
        })
    }
}

#[async_trait]
impl AiProvider for OllamaProvider {
    fn kind(&self) -> &str {
        "ollama"
    }

    async fn complete(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, AiProviderError> {
        let url = format!("{}/api/chat", self.base_url());
        let messages = self.build_messages(&request);

        let mut body = json!({
            "model": request.model,
            "messages": messages,
            "stream": false,
        });

        if let Some(ref options) = request.temperature {
            body["options"] = json!({"temperature": options});
        }

        if let Some(tools) = self.build_tools(&request) {
            body["tools"] = json!(tools);
        }

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AiProviderError::Api {
                status: status.as_u16(),
                message: text,
                provider_code: None,
            });
        }

        let json_body: Value = resp.json().await?;
        let msg_body = &json_body["message"];

        // Ollama may return tool_calls in the message
        let tool_calls_raw = msg_body["tool_calls"].as_array();
        let message = if let Some(tcs) = tool_calls_raw {
            let calls: Vec<ToolCall> = tcs
                .iter()
                .enumerate()
                .filter_map(|(i, tc)| {
                    let func = &tc["function"];
                    let name = func["name"].as_str()?;
                    Some(ToolCall {
                        id: format!("ollama_{i}"),
                        name: name.to_string(),
                        arguments: func["arguments"].clone(),
                    })
                })
                .collect();
            if calls.is_empty() {
                Message::assistant(
                    msg_body["content"].as_str().unwrap_or_default().to_string(),
                )
            } else {
                Message {
                    role: Role::Assistant,
                    content: MessageContent::ToolUse { tool_calls: calls },
                    tool_call_id: None,
                }
            }
        } else {
            Message::assistant(msg_body["content"].as_str().unwrap_or_default().to_string())
        };

        let prompt_tokens = json_body["prompt_eval_count"].as_u64().unwrap_or(0) as u32;
        let completion_tokens = json_body["eval_count"].as_u64().unwrap_or(0) as u32;

        Ok(CompletionResponse {
            message,
            usage: Some(Usage {
                prompt_tokens,
                completion_tokens,
                total_tokens: prompt_tokens + completion_tokens,
            }),
            model: json_body["model"]
                .as_str()
                .unwrap_or(&request.model)
                .to_string(),
            finish_reason: json_body["done_reason"].as_str().map(String::from),
        })
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        tx: mpsc::Sender<StreamDelta>,
    ) -> Result<CompletionResponse, AiProviderError> {
        let url = format!("{}/api/chat", self.base_url());
        let messages = self.build_messages(&request);

        let mut body = json!({
            "model": request.model,
            "messages": messages,
            "stream": true,
        });

        if let Some(ref temp) = request.temperature {
            body["options"] = json!({"temperature": temp});
        }

        if let Some(tools) = self.build_tools(&request) {
            body["tools"] = json!(tools);
        }

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await?;

        let status_code = resp.status();
        if !status_code.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AiProviderError::Api {
                status: status_code.as_u16(),
                message: text,
                provider_code: None,
            });
        }

        let mut full_text = String::new();
        let model = request.model.clone();
        let mut usage = None;
        let mut finish_reason = None;

        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();

        use futures::StreamExt;
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(AiProviderError::Http)?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            // Ollama sends NDJSON: one JSON object per line
            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    let done = event["done"].as_bool().unwrap_or(false);

                    if done {
                        let prompt_tokens =
                            event["prompt_eval_count"].as_u64().unwrap_or(0) as u32;
                        let completion_tokens = event["eval_count"].as_u64().unwrap_or(0) as u32;
                        usage = Some(Usage {
                            prompt_tokens,
                            completion_tokens,
                            total_tokens: prompt_tokens + completion_tokens,
                        });
                        finish_reason = event["done_reason"].as_str().map(String::from);
                        if let Some(ref u) = usage {
                            let _ = tx.send(StreamDelta::Usage(u.clone())).await;
                        }
                        let _ = tx.send(StreamDelta::Done).await;
                    } else if let Some(msg) = event.get("message") {
                        if let Some(text) = msg["content"].as_str() {
                            if !text.is_empty() {
                                full_text.push_str(text);
                                let _ = tx
                                    .send(StreamDelta::Text {
                                        text: text.to_string(),
                                    })
                                    .await;
                            }
                        }
                    }
                }
            }
        }

        Ok(CompletionResponse {
            message: Message::assistant(full_text),
            usage,
            model,
            finish_reason,
        })
    }

    async fn list_models(&self) -> Result<Vec<Model>, AiProviderError> {
        let url = format!("{}/api/tags", self.base_url());
        let resp = self
            .client
            .get(&url)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(AiProviderError::Api {
                status: resp.status().as_u16(),
                message: "Failed to list Ollama models".into(),
                provider_code: None,
            });
        }

        let body: Value = resp.json().await?;
        let models = body["models"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let name = m["name"].as_str()?;
                        let size = m["size"].as_u64().unwrap_or(0);
                        Some(Model {
                            id: name.to_string(),
                            name: m["model"].as_str().unwrap_or(name).to_string(),
                            context_window: if size > 0 { Some(128_000) } else { None },
                            supports_tools: true,
                            supports_streaming: true,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        Ok(models)
    }

    async fn health_check(&self) -> Result<(), AiProviderError> {
        let url = format!("{}/api/tags", self.base_url());
        let resp = self
            .client
            .get(&url)
            .send()
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(AiProviderError::Api {
                status: resp.status().as_u16(),
                message: "Ollama is not running or unreachable".into(),
                provider_code: None,
            })
        }
    }
}
