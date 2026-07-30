//! Anthropic Claude provider implementation.
//!
//! Supports Claude 4 Opus, Claude Sonnet 4, etc. via the Anthropic Messages API.

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tokio::sync::mpsc;

use crate::config::ProviderConfig;
use crate::error::AiProviderError;
use crate::limits::{
    parse_tool_arguments, read_error_body, read_json_body, send_delta, validate_completion_request,
    validate_response_message, validate_string, BoundedString, LineDecoder, StreamBudget,
    MAX_MODEL_BYTES, MAX_STREAM_OUTPUT_BYTES, MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_CALLS_PER_MESSAGE,
    MAX_TOOL_CALL_ID_BYTES, MAX_TOOL_NAME_BYTES,
};
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
        config.validate()?;
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
        config.validate()?;
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
        let sys = request.system.as_deref().or_else(|| {
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

        let mut full_text = BoundedString::new("response output", MAX_STREAM_OUTPUT_BYTES);
        let mut tool_calls = Vec::new();

        for block in content {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(t) = block["text"].as_str() {
                        full_text.push_str(t)?;
                    }
                }
                Some("tool_use") => {
                    if let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str()) {
                        if tool_calls.len() >= MAX_TOOL_CALLS_PER_MESSAGE {
                            return Err(AiProviderError::LimitExceeded {
                                resource: "response tool calls",
                                limit: MAX_TOOL_CALLS_PER_MESSAGE,
                                actual: tool_calls.len().saturating_add(1),
                            });
                        }
                        validate_string("tool-call id", id, MAX_TOOL_CALL_ID_BYTES)?;
                        validate_string("tool name", name, MAX_TOOL_NAME_BYTES)?;
                        let arguments = block.get("input").cloned().ok_or_else(|| {
                            AiProviderError::Parse("Anthropic tool call omitted its input".into())
                        })?;
                        crate::limits::serialized_len_limited(
                            "tool-call arguments",
                            &arguments,
                            MAX_TOOL_ARGUMENT_BYTES,
                        )?;
                        tool_calls.push(ToolCall {
                            id: id.to_string(),
                            name: name.to_string(),
                            arguments,
                        });
                    } else {
                        return Err(AiProviderError::Parse(
                            "Anthropic tool call omitted its id or name".into(),
                        ));
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
            Message::assistant(full_text.into_string())
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

        validate_response_message(&message)?;
        Ok(CompletionResponse {
            message,
            usage,
            model,
            finish_reason,
        })
    }
}

struct PendingAnthropicToolCall {
    id: String,
    name: String,
    arguments: BoundedString,
    ended: bool,
}

struct AnthropicStreamState {
    full_text: BoundedString,
    tool_calls: BTreeMap<usize, PendingAnthropicToolCall>,
    retained_output_bytes: usize,
    usage: Option<Usage>,
    finish_reason: Option<String>,
    saw_done: bool,
}

impl AnthropicStreamState {
    fn new() -> Self {
        Self {
            full_text: BoundedString::new("streamed response output", MAX_STREAM_OUTPUT_BYTES),
            tool_calls: BTreeMap::new(),
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

    fn event_index(event: &Value) -> Result<usize, AiProviderError> {
        let index = event["index"]
            .as_u64()
            .ok_or_else(|| AiProviderError::Parse("Anthropic stream event omitted index".into()))?
            as usize;
        if index >= MAX_TOOL_CALLS_PER_MESSAGE {
            return Err(AiProviderError::LimitExceeded {
                resource: "streamed content blocks",
                limit: MAX_TOOL_CALLS_PER_MESSAGE,
                actual: index.saturating_add(1),
            });
        }
        Ok(index)
    }

    async fn process_line(
        &mut self,
        line: &str,
        tx: &mpsc::Sender<StreamDelta>,
    ) -> Result<(), AiProviderError> {
        let line = line.trim();
        if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
            return Ok(());
        }
        let Some(data) = line.strip_prefix("data:") else {
            return Ok(());
        };
        let event: Value = serde_json::from_str(data.trim_start()).map_err(|error| {
            AiProviderError::Parse(format!("invalid Anthropic SSE JSON: {error}"))
        })?;

        match event["type"].as_str() {
            Some("content_block_start") => {
                let block = &event["content_block"];
                if block["type"].as_str() == Some("tool_use") {
                    let index = Self::event_index(&event)?;
                    if self.tool_calls.contains_key(&index) {
                        return Err(AiProviderError::Parse(format!(
                            "duplicate Anthropic tool block index {index}"
                        )));
                    }
                    let id = block["id"].as_str().ok_or_else(|| {
                        AiProviderError::Parse("Anthropic tool block omitted id".into())
                    })?;
                    let name = block["name"].as_str().ok_or_else(|| {
                        AiProviderError::Parse("Anthropic tool block omitted name".into())
                    })?;
                    validate_string("tool-call id", id, MAX_TOOL_CALL_ID_BYTES)?;
                    validate_string("tool name", name, MAX_TOOL_NAME_BYTES)?;
                    self.retain(id.len().saturating_add(name.len()))?;

                    let mut arguments =
                        BoundedString::new("streamed tool-call arguments", MAX_TOOL_ARGUMENT_BYTES);
                    if let Some(input) = block.get("input") {
                        if input.as_object().is_none_or(|object| !object.is_empty()) {
                            let initial = serde_json::to_string(input).map_err(|error| {
                                AiProviderError::Parse(format!(
                                    "invalid Anthropic initial tool input: {error}"
                                ))
                            })?;
                            self.retain(initial.len())?;
                            arguments.push_str(&initial)?;
                        }
                    }
                    self.tool_calls.insert(
                        index,
                        PendingAnthropicToolCall {
                            id: id.to_string(),
                            name: name.to_string(),
                            arguments,
                            ended: false,
                        },
                    );
                    send_delta(
                        tx,
                        StreamDelta::ToolCallStart {
                            id: id.to_string(),
                            name: name.to_string(),
                        },
                    )
                    .await?;
                }
            }
            Some("content_block_delta") => {
                let delta = &event["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        let text = delta["text"].as_str().ok_or_else(|| {
                            AiProviderError::Parse("Anthropic text delta omitted text".into())
                        })?;
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
                    Some("input_json_delta") => {
                        let index = Self::event_index(&event)?;
                        let partial = delta["partial_json"].as_str().ok_or_else(|| {
                            AiProviderError::Parse(
                                "Anthropic input delta omitted partial JSON".into(),
                            )
                        })?;
                        self.retain(partial.len())?;
                        let pending = self.tool_calls.get_mut(&index).ok_or_else(|| {
                            AiProviderError::Parse(format!(
                                "Anthropic input delta preceded tool block {index}"
                            ))
                        })?;
                        if pending.ended {
                            return Err(AiProviderError::Parse(format!(
                                "Anthropic input delta followed closed tool block {index}"
                            )));
                        }
                        pending.arguments.push_str(partial)?;
                        send_delta(
                            tx,
                            StreamDelta::ToolCallDelta {
                                id: pending.id.clone(),
                                arguments: partial.to_string(),
                            },
                        )
                        .await?;
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                let index = Self::event_index(&event)?;
                if let Some(pending) = self.tool_calls.get_mut(&index) {
                    pending.ended = true;
                }
            }
            Some("message_delta") => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    validate_string("finish reason", reason, MAX_MODEL_BYTES)?;
                    self.finish_reason = Some(reason.to_string());
                }
                if let Some(raw_usage) = event.get("usage") {
                    let output = raw_usage["output_tokens"].as_u64().unwrap_or(0) as u32;
                    let prompt = self.usage.as_ref().map_or(0, |usage| usage.prompt_tokens);
                    self.usage = Some(Usage {
                        prompt_tokens: prompt,
                        completion_tokens: output,
                        total_tokens: prompt.saturating_add(output),
                    });
                }
            }
            Some("message_start") => {
                if let Some(raw_usage) = event["message"].get("usage") {
                    let prompt = raw_usage["input_tokens"].as_u64().unwrap_or(0) as u32;
                    let output = raw_usage["output_tokens"].as_u64().unwrap_or(0) as u32;
                    self.usage = Some(Usage {
                        prompt_tokens: prompt,
                        completion_tokens: output,
                        total_tokens: prompt.saturating_add(output),
                    });
                }
            }
            Some("message_stop") => {
                self.saw_done = true;
            }
            Some("error") => {
                let message = event["error"]["message"]
                    .as_str()
                    .unwrap_or("Anthropic stream returned an error");
                validate_string("stream error", message, crate::limits::MAX_ERROR_BODY_BYTES)?;
                return Err(AiProviderError::Other(message.to_string()));
            }
            _ => {}
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
                "Anthropic stream ended before message_stop".into(),
            ));
        }

        let message = if self.tool_calls.is_empty() {
            Message::assistant(self.full_text.into_string())
        } else {
            let mut tool_calls = Vec::with_capacity(self.tool_calls.len());
            for (_, pending) in self.tool_calls {
                if !pending.ended {
                    return Err(AiProviderError::StreamClosed(format!(
                        "Anthropic tool call {} ended before content_block_stop",
                        pending.id
                    )));
                }
                let arguments = parse_tool_arguments(pending.arguments.as_str())?;
                send_delta(
                    tx,
                    StreamDelta::ToolCallEnd {
                        id: pending.id.clone(),
                    },
                )
                .await?;
                tool_calls.push(ToolCall {
                    id: pending.id,
                    name: pending.name,
                    arguments,
                });
            }
            Message {
                role: Role::Assistant,
                content: MessageContent::ToolUse { tool_calls },
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
        validate_completion_request(&request)?;
        let url = format!("{}/messages", self.base_url());
        let body = self.build_body(&request);

        let resp = self
            .client
            .post(&url)
            .header(
                "x-api-key",
                self.config.api_key.as_deref().unwrap_or_default(),
            )
            .header("anthropic-version", ANTHROPIC_API_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let code = status.as_u16();
            let text = read_error_body(resp).await?;
            let parsed: ApiError = serde_json::from_str(&text).unwrap_or(ApiError { error: None });
            let message = parsed
                .error
                .as_ref()
                .and_then(|e| e.message.clone())
                .unwrap_or(text);
            let provider_code = parsed.error.and_then(|e| e.error_type);

            if code == 429 {
                return Err(AiProviderError::RateLimited {
                    retry_after_ms: None,
                });
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

        let json_body = read_json_body(resp).await?;
        self.parse_response(json_body)
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        tx: mpsc::Sender<StreamDelta>,
    ) -> Result<CompletionResponse, AiProviderError> {
        validate_completion_request(&request)?;
        let url = format!("{}/messages", self.base_url());
        let mut body = self.build_body(&request);
        body["stream"] = json!(true);

        let resp = self
            .client
            .post(&url)
            .header(
                "x-api-key",
                self.config.api_key.as_deref().unwrap_or_default(),
            )
            .header("anthropic-version", ANTHROPIC_API_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = read_error_body(resp).await?;
            return Err(AiProviderError::Api {
                status,
                message: text,
                provider_code: None,
            });
        }

        let model = request.model.clone();

        let mut stream = resp.bytes_stream();
        let mut decoder = LineDecoder::new();
        let mut budget = StreamBudget::new();
        let mut state = AnthropicStreamState::new();

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
            .header(
                "x-api-key",
                self.config.api_key.as_deref().unwrap_or_default(),
            )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn anthropic_tool_json_is_bounded_and_finalized_without_corruption() {
        let (tx, _rx) = mpsc::channel(8);
        let mut state = AnthropicStreamState::new();
        state
            .process_line(
                r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"lookup","input":{}}}"#,
                &tx,
            )
            .await
            .expect("tool start");
        state
            .process_line(
                r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"zone\":\"example.com\"}"}}"#,
                &tx,
            )
            .await
            .expect("arguments");
        state
            .process_line(r#"data: {"type":"content_block_stop","index":0}"#, &tx)
            .await
            .expect("tool stop");
        state
            .process_line(r#"data: {"type":"message_stop"}"#, &tx)
            .await
            .expect("message stop");

        let response = state.finish(&tx, "mock".into()).await.expect("valid tool");
        let MessageContent::ToolUse { tool_calls } = response.message.content else {
            panic!("expected tool call");
        };
        assert_eq!(tool_calls[0].arguments["zone"], "example.com");
    }

    #[tokio::test]
    async fn anthropic_incomplete_tool_block_is_not_silently_completed() {
        let (tx, _rx) = mpsc::channel(8);
        let mut state = AnthropicStreamState::new();
        state
            .process_line(
                r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"lookup","input":{}}}"#,
                &tx,
            )
            .await
            .expect("tool start");
        state
            .process_line(r#"data: {"type":"message_stop"}"#, &tx)
            .await
            .expect("message stop");
        assert!(matches!(
            state.finish(&tx, "mock".into()).await,
            Err(AiProviderError::StreamClosed(_))
        ));
    }
}
