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
use crate::limits::{
    parse_tool_arguments, read_error_body, read_json_body, send_delta, validate_completion_request,
    validate_response_message, validate_string, BoundedString, LineDecoder, StreamBudget,
    MAX_MODEL_BYTES, MAX_STREAM_OUTPUT_BYTES, MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_CALLS_PER_MESSAGE,
    MAX_TOOL_CALL_ID_BYTES, MAX_TOOL_NAME_BYTES,
};
use crate::traits::AiProvider;
use crate::types::*;

/// OpenAI provider client.
pub struct OpenAiProvider {
    client: Client,
    config: ProviderConfig,
}

impl OpenAiProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, AiProviderError> {
        config.validate()?;
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
        config.validate()?;
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
            if tool_calls.len() > MAX_TOOL_CALLS_PER_MESSAGE {
                return Err(AiProviderError::LimitExceeded {
                    resource: "response tool calls",
                    limit: MAX_TOOL_CALLS_PER_MESSAGE,
                    actual: tool_calls.len(),
                });
            }
            let mut calls = Vec::with_capacity(tool_calls.len());
            for tc in tool_calls {
                let id = tc["id"].as_str().ok_or_else(|| {
                    AiProviderError::Parse("OpenAI tool call omitted its id".into())
                })?;
                let name = tc["function"]["name"].as_str().ok_or_else(|| {
                    AiProviderError::Parse("OpenAI tool call omitted its function name".into())
                })?;
                let args_str = tc["function"]["arguments"].as_str().ok_or_else(|| {
                    AiProviderError::Parse("OpenAI tool call omitted its arguments".into())
                })?;
                validate_string("tool-call id", id, MAX_TOOL_CALL_ID_BYTES)?;
                validate_string("tool name", name, MAX_TOOL_NAME_BYTES)?;
                calls.push(ToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments: parse_tool_arguments(args_str)?,
                });
            }
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

        let model = body["model"]
            .as_str()
            .unwrap_or(&self.config.model)
            .to_string();

        validate_response_message(&message)?;
        Ok(CompletionResponse {
            message,
            usage,
            model,
            finish_reason,
        })
    }
}

struct PendingOpenAiToolCall {
    id: BoundedString,
    name: BoundedString,
    arguments: BoundedString,
    start_emitted: bool,
}

impl PendingOpenAiToolCall {
    fn new() -> Self {
        Self {
            id: BoundedString::new("streamed tool-call id", MAX_TOOL_CALL_ID_BYTES),
            name: BoundedString::new("streamed tool name", MAX_TOOL_NAME_BYTES),
            arguments: BoundedString::new("streamed tool-call arguments", MAX_TOOL_ARGUMENT_BYTES),
            start_emitted: false,
        }
    }
}

struct OpenAiStreamState {
    full_text: BoundedString,
    tool_calls: Vec<PendingOpenAiToolCall>,
    retained_output_bytes: usize,
    usage: Option<Usage>,
    finish_reason: Option<String>,
    saw_done: bool,
}

impl OpenAiStreamState {
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

    fn tool_call_mut(
        &mut self,
        index: usize,
    ) -> Result<&mut PendingOpenAiToolCall, AiProviderError> {
        if index >= MAX_TOOL_CALLS_PER_MESSAGE {
            return Err(AiProviderError::LimitExceeded {
                resource: "streamed tool calls",
                limit: MAX_TOOL_CALLS_PER_MESSAGE,
                actual: index.saturating_add(1),
            });
        }
        while self.tool_calls.len() <= index {
            self.tool_calls.push(PendingOpenAiToolCall::new());
        }
        Ok(&mut self.tool_calls[index])
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
        let data = data.trim_start();
        if data == "[DONE]" {
            self.saw_done = true;
            return Ok(());
        }

        let chunk_json: Value = serde_json::from_str(data)
            .map_err(|error| AiProviderError::Parse(format!("invalid OpenAI SSE JSON: {error}")))?;
        if let Some(choice) = chunk_json["choices"].get(0) {
            let delta = &choice["delta"];
            if let Some(text) = delta["content"].as_str() {
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

            if let Some(tool_calls) = delta["tool_calls"].as_array() {
                for tool_call in tool_calls {
                    let index = tool_call["index"].as_u64().ok_or_else(|| {
                        AiProviderError::Parse("OpenAI tool delta omitted its index".into())
                    })? as usize;
                    let function = tool_call.get("function");
                    let id_fragment = tool_call["id"].as_str();
                    let name_fragment = function.and_then(|value| value["name"].as_str());
                    let argument_fragment = function.and_then(|value| value["arguments"].as_str());

                    let retained = id_fragment.map_or(0, str::len)
                        + name_fragment.map_or(0, str::len)
                        + argument_fragment.map_or(0, str::len);
                    self.retain(retained)?;

                    let pending = self.tool_call_mut(index)?;
                    if let Some(id) = id_fragment {
                        pending.id.push_str(id)?;
                    }
                    if let Some(name) = name_fragment {
                        pending.name.push_str(name)?;
                    }
                    if !pending.start_emitted && !pending.name.as_str().is_empty() {
                        send_delta(
                            tx,
                            StreamDelta::ToolCallStart {
                                id: pending.id.as_str().to_string(),
                                name: pending.name.as_str().to_string(),
                            },
                        )
                        .await?;
                        pending.start_emitted = true;
                    }
                    if let Some(arguments) = argument_fragment {
                        pending.arguments.push_str(arguments)?;
                        send_delta(
                            tx,
                            StreamDelta::ToolCallDelta {
                                id: pending.id.as_str().to_string(),
                                arguments: arguments.to_string(),
                            },
                        )
                        .await?;
                    }
                }
            }

            if let Some(reason) = choice["finish_reason"].as_str() {
                validate_string("finish reason", reason, MAX_MODEL_BYTES)?;
                self.finish_reason = Some(reason.to_string());
            }
        }

        if let Some(raw_usage) = chunk_json.get("usage") {
            let usage = Usage {
                prompt_tokens: raw_usage["prompt_tokens"].as_u64().unwrap_or(0) as u32,
                completion_tokens: raw_usage["completion_tokens"].as_u64().unwrap_or(0) as u32,
                total_tokens: raw_usage["total_tokens"].as_u64().unwrap_or(0) as u32,
            };
            send_delta(tx, StreamDelta::Usage(usage.clone())).await?;
            self.usage = Some(usage);
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
                "OpenAI stream ended before [DONE]".into(),
            ));
        }

        let message = if self.tool_calls.is_empty() {
            Message::assistant(self.full_text.into_string())
        } else {
            let mut tool_calls = Vec::with_capacity(self.tool_calls.len());
            for pending in self.tool_calls {
                if pending.id.as_str().is_empty() || pending.name.as_str().is_empty() {
                    return Err(AiProviderError::Parse(
                        "OpenAI stream ended with an incomplete tool-call identity".into(),
                    ));
                }
                let id = pending.id.into_string();
                let arguments = parse_tool_arguments(pending.arguments.as_str())?;
                send_delta(tx, StreamDelta::ToolCallEnd { id: id.clone() }).await?;
                tool_calls.push(ToolCall {
                    id,
                    name: pending.name.into_string(),
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
        send_delta(tx, StreamDelta::Done).await?;
        Ok(CompletionResponse {
            message,
            usage: self.usage,
            model,
            finish_reason: self.finish_reason,
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
        validate_completion_request(&request)?;
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
            let text = read_error_body(resp).await?;
            let parsed: ApiErrorBody =
                serde_json::from_str(&text).unwrap_or(ApiErrorBody { error: None });
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

        let json_body = read_json_body(resp).await?;
        self.parse_response(json_body)
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        tx: mpsc::Sender<StreamDelta>,
    ) -> Result<CompletionResponse, AiProviderError> {
        validate_completion_request(&request)?;
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
        let mut state = OpenAiStreamState::new();

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
        let url = format!("{}/models", self.base_url());
        let resp = self
            .client
            .get(&url)
            .header("Authorization", self.auth_header())
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

        let body: ModelsResponse = serde_json::from_value(read_json_body(resp).await?)
            .map_err(|error| AiProviderError::Parse(error.to_string()))?;
        let models = body
            .data
            .into_iter()
            .filter(|m| {
                m.id.starts_with("gpt-") || m.id.starts_with("o1") || m.id.starts_with("o3")
            })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn streamed_tool_arguments_are_assembled_only_after_valid_json() {
        let (tx, _rx) = mpsc::channel(8);
        let mut state = OpenAiStreamState::new();
        state
            .process_line(
                r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\"zone\":"}}]}}]}"#,
                &tx,
            )
            .await
            .expect("first fragment");
        state
            .process_line(
                r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"example.com\"}"}}]}}]}"#,
                &tx,
            )
            .await
            .expect("second fragment");
        state.process_line("data: [DONE]", &tx).await.expect("done");

        let response = state.finish(&tx, "mock".into()).await.expect("valid tool");
        let MessageContent::ToolUse { tool_calls } = response.message.content else {
            panic!("expected tool call");
        };
        assert_eq!(tool_calls[0].arguments["zone"], "example.com");
    }

    #[tokio::test]
    async fn streamed_partial_tool_json_is_an_explicit_error() {
        let (tx, _rx) = mpsc::channel(8);
        let mut state = OpenAiStreamState::new();
        state
            .process_line(
                r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{"}}]}}]}"#,
                &tx,
            )
            .await
            .expect("partial fragment");
        state.process_line("data: [DONE]", &tx).await.expect("done");
        assert!(matches!(
            state.finish(&tx, "mock".into()).await,
            Err(AiProviderError::Parse(_))
        ));
    }
}
