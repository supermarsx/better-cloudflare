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
use crate::limits::{
    read_error_body, read_json_body, send_delta, serialized_len_limited,
    validate_completion_request, validate_response_message, validate_string, BoundedString,
    LineDecoder, StreamBudget, MAX_STREAM_OUTPUT_BYTES, MAX_TOOL_ARGUMENT_BYTES,
    MAX_TOOL_CALLS_PER_MESSAGE, MAX_TOOL_NAME_BYTES,
};
use crate::traits::AiProvider;
use crate::types::*;

/// Ollama local LLM provider.
pub struct OllamaProvider {
    client: Client,
    config: ProviderConfig,
}

impl OllamaProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, AiProviderError> {
        config.validate()?;
        Ok(Self {
            client: Client::new(),
            config,
        })
    }

    pub fn with_client(client: Client, config: ProviderConfig) -> Result<Self, AiProviderError> {
        config.validate()?;
        Ok(Self { client, config })
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

struct OllamaStreamState {
    full_text: BoundedString,
    tool_calls: Vec<ToolCall>,
    retained_output_bytes: usize,
    usage: Option<Usage>,
    finish_reason: Option<String>,
    saw_done: bool,
}

impl OllamaStreamState {
    fn new() -> Self {
        Self {
            full_text: BoundedString::new("streamed response output", MAX_STREAM_OUTPUT_BYTES),
            tool_calls: Vec::new(),
            retained_output_bytes: 0,
            usage: None,
            finish_reason: None,
            saw_done: false,
        }
    }

    fn retain(&mut self, bytes: usize) -> Result<(), AiProviderError> {
        let actual = self.retained_output_bytes.saturating_add(bytes);
        if actual > MAX_STREAM_OUTPUT_BYTES {
            return Err(AiProviderError::LimitExceeded {
                resource: "streamed response output",
                limit: MAX_STREAM_OUTPUT_BYTES,
                actual,
            });
        }
        self.retained_output_bytes = actual;
        Ok(())
    }

    async fn process_line(
        &mut self,
        line: &str,
        tx: &mpsc::Sender<StreamDelta>,
    ) -> Result<(), AiProviderError> {
        let line = line.trim();
        if line.is_empty() {
            return Ok(());
        }
        let event: Value = serde_json::from_str(line)
            .map_err(|error| AiProviderError::Parse(format!("invalid Ollama NDJSON: {error}")))?;

        if let Some(message) = event.get("message") {
            if let Some(text) = message["content"].as_str() {
                if !text.is_empty() {
                    self.retain(text.len())?;
                    self.full_text.push_str(text)?;
                    send_delta(
                        tx,
                        StreamDelta::Text {
                            text: text.to_string(),
                        },
                    )
                    .await?;
                }
            }
            if let Some(raw_calls) = message["tool_calls"].as_array() {
                for raw_call in raw_calls {
                    if self.tool_calls.len() >= MAX_TOOL_CALLS_PER_MESSAGE {
                        return Err(AiProviderError::LimitExceeded {
                            resource: "streamed tool calls",
                            limit: MAX_TOOL_CALLS_PER_MESSAGE,
                            actual: self.tool_calls.len().saturating_add(1),
                        });
                    }
                    let function = &raw_call["function"];
                    let name = function["name"].as_str().ok_or_else(|| {
                        AiProviderError::Parse("Ollama tool call omitted function name".into())
                    })?;
                    validate_string("tool name", name, MAX_TOOL_NAME_BYTES)?;
                    let arguments = function.get("arguments").cloned().ok_or_else(|| {
                        AiProviderError::Parse("Ollama tool call omitted arguments".into())
                    })?;
                    let argument_bytes = serialized_len_limited(
                        "tool-call arguments",
                        &arguments,
                        MAX_TOOL_ARGUMENT_BYTES,
                    )?;
                    self.retain(name.len().saturating_add(argument_bytes))?;
                    let id = format!("ollama_{}", self.tool_calls.len());
                    send_delta(
                        tx,
                        StreamDelta::ToolCallStart {
                            id: id.clone(),
                            name: name.to_string(),
                        },
                    )
                    .await?;
                    let serialized_arguments =
                        serde_json::to_string(&arguments).map_err(|error| {
                            AiProviderError::Parse(format!(
                                "could not serialize Ollama tool arguments: {error}"
                            ))
                        })?;
                    send_delta(
                        tx,
                        StreamDelta::ToolCallDelta {
                            id: id.clone(),
                            arguments: serialized_arguments,
                        },
                    )
                    .await?;
                    self.tool_calls.push(ToolCall {
                        id,
                        name: name.to_string(),
                        arguments,
                    });
                }
            }
        }

        if event["done"].as_bool().unwrap_or(false) {
            self.saw_done = true;
            let prompt = event["prompt_eval_count"].as_u64().unwrap_or(0) as u32;
            let completion = event["eval_count"].as_u64().unwrap_or(0) as u32;
            self.usage = Some(Usage {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens: prompt.saturating_add(completion),
            });
            self.finish_reason = event["done_reason"].as_str().map(String::from);
        }
        Ok(())
    }

    async fn finish(
        self,
        tx: &mpsc::Sender<StreamDelta>,
        model: String,
    ) -> Result<CompletionResponse, AiProviderError> {
        if !self.saw_done {
            return Err(AiProviderError::StreamClosed(
                "Ollama stream ended before done=true".into(),
            ));
        }

        let message = if self.tool_calls.is_empty() {
            Message::assistant(self.full_text.into_string())
        } else {
            for tool_call in &self.tool_calls {
                send_delta(
                    tx,
                    StreamDelta::ToolCallEnd {
                        id: tool_call.id.clone(),
                    },
                )
                .await?;
            }
            Message {
                role: Role::Assistant,
                content: MessageContent::ToolUse {
                    tool_calls: self.tool_calls,
                },
                tool_call_id: None,
            }
        };
        validate_response_message(&message)?;
        if let Some(usage) = &self.usage {
            send_delta(tx, StreamDelta::Usage(usage.clone())).await?;
        }
        send_delta(tx, StreamDelta::Done).await?;
        Ok(CompletionResponse {
            message,
            usage: self.usage,
            model,
            finish_reason: self.finish_reason,
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
        validate_completion_request(&request)?;
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

        let resp = self.client.post(&url).json(&body).send().await?;

        let status = resp.status();
        if !status.is_success() {
            let text = read_error_body(resp).await?;
            return Err(AiProviderError::Api {
                status: status.as_u16(),
                message: text,
                provider_code: None,
            });
        }

        let json_body = read_json_body(resp).await?;
        let msg_body = &json_body["message"];

        // Ollama may return tool_calls in the message
        let tool_calls_raw = msg_body["tool_calls"].as_array();
        let message = if let Some(tcs) = tool_calls_raw {
            if tcs.len() > MAX_TOOL_CALLS_PER_MESSAGE {
                return Err(AiProviderError::LimitExceeded {
                    resource: "response tool calls",
                    limit: MAX_TOOL_CALLS_PER_MESSAGE,
                    actual: tcs.len(),
                });
            }
            let mut calls = Vec::with_capacity(tcs.len());
            for (index, tool_call) in tcs.iter().enumerate() {
                let function = &tool_call["function"];
                let name = function["name"].as_str().ok_or_else(|| {
                    AiProviderError::Parse("Ollama tool call omitted function name".into())
                })?;
                validate_string("tool name", name, MAX_TOOL_NAME_BYTES)?;
                let arguments = function.get("arguments").cloned().ok_or_else(|| {
                    AiProviderError::Parse("Ollama tool call omitted arguments".into())
                })?;
                serialized_len_limited("tool-call arguments", &arguments, MAX_TOOL_ARGUMENT_BYTES)?;
                calls.push(ToolCall {
                    id: format!("ollama_{index}"),
                    name: name.to_string(),
                    arguments,
                });
            }
            if calls.is_empty() {
                Message::assistant(msg_body["content"].as_str().unwrap_or_default().to_string())
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

        validate_response_message(&message)?;
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
        validate_completion_request(&request)?;
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

        let resp = self.client.post(&url).json(&body).send().await?;

        let status_code = resp.status();
        if !status_code.is_success() {
            let text = read_error_body(resp).await?;
            return Err(AiProviderError::Api {
                status: status_code.as_u16(),
                message: text,
                provider_code: None,
            });
        }

        let model = request.model.clone();

        let mut stream = resp.bytes_stream();
        let mut decoder = LineDecoder::new();
        let mut budget = StreamBudget::new();
        let mut state = OllamaStreamState::new();

        use futures::StreamExt;
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(AiProviderError::Http)?;
            budget.add(bytes.len())?;
            for line in decoder.push(&bytes)? {
                state.process_line(&line, &tx).await?;
            }
        }
        if let Some(line) = decoder.finish()? {
            state.process_line(&line, &tx).await?;
        }
        state.finish(&tx, model).await
    }

    async fn list_models(&self) -> Result<Vec<Model>, AiProviderError> {
        let url = format!("{}/api/tags", self.base_url());
        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            return Err(AiProviderError::Api {
                status: resp.status().as_u16(),
                message: "Failed to list Ollama models".into(),
                provider_code: None,
            });
        }

        let body = read_json_body(resp).await?;
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
        let resp = self.client.get(&url).send().await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ollama_ndjson_requires_valid_lines_and_done_marker() {
        let (tx, _rx) = mpsc::channel(8);
        let mut malformed = OllamaStreamState::new();
        assert!(matches!(
            malformed.process_line("{not-json}", &tx).await,
            Err(AiProviderError::Parse(_))
        ));

        let mut incomplete = OllamaStreamState::new();
        incomplete
            .process_line(r#"{"message":{"content":"partial"},"done":false}"#, &tx)
            .await
            .expect("valid partial line");
        assert!(matches!(
            incomplete.finish(&tx, "mock".into()).await,
            Err(AiProviderError::StreamClosed(_))
        ));
    }

    #[tokio::test]
    async fn ollama_tool_arguments_remain_structured() {
        let (tx, _rx) = mpsc::channel(8);
        let mut state = OllamaStreamState::new();
        state
            .process_line(
                r#"{"message":{"content":"","tool_calls":[{"function":{"name":"lookup","arguments":{"zone":"example.com"}}}]},"done":false}"#,
                &tx,
            )
            .await
            .expect("tool line");
        state
            .process_line(
                r#"{"done":true,"prompt_eval_count":1,"eval_count":2,"done_reason":"stop"}"#,
                &tx,
            )
            .await
            .expect("done line");

        let response = state.finish(&tx, "mock".into()).await.expect("response");
        let MessageContent::ToolUse { tool_calls } = response.message.content else {
            panic!("expected tool call");
        };
        assert_eq!(tool_calls[0].arguments["zone"], "example.com");
    }
}
