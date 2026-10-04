//! Shared defensive limits and bounded streaming primitives.
//!
//! These limits are intentionally provider-independent so every backend has
//! the same memory and request-safety contract.

use std::io::{self, Write};

use futures::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::{AiProviderError, CompletionRequest, Message, MessageContent, StreamDelta};

pub const MAX_MODEL_BYTES: usize = 256;
pub const MAX_API_KEY_BYTES: usize = 16 * 1024;
pub const MAX_BASE_URL_BYTES: usize = 2 * 1024;
pub const MAX_SYSTEM_PROMPT_BYTES: usize = 256 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 512 * 1024;
pub const MAX_TOOL_RESULT_BYTES: usize = 512 * 1024;
pub const MAX_TOOL_ARGUMENT_BYTES: usize = 256 * 1024;
pub const MAX_TOOL_SCHEMA_BYTES: usize = 256 * 1024;
pub const MAX_TOOL_DESCRIPTION_BYTES: usize = 16 * 1024;
pub const MAX_TOOL_NAME_BYTES: usize = 128;
pub const MAX_TOOL_CALL_ID_BYTES: usize = 256;
pub const MAX_REQUEST_MESSAGES: usize = 256;
pub const MAX_REQUEST_TOOLS: usize = 128;
pub const MAX_TOOL_CALLS_PER_MESSAGE: usize = 64;
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_COMPLETION_TOKENS: u32 = 131_072;

/// Sampling-temperature bounds. Zero is greedy decoding, not "unset".
pub const MIN_TEMPERATURE: f32 = 0.0;
pub const MAX_TEMPERATURE: f32 = 2.0;
/// Nucleus-sampling bounds. `top_p` is a probability mass, so 1.0 is "keep
/// everything" and anything above it is meaningless rather than permissive.
pub const MIN_TOP_P: f32 = 0.0;
pub const MAX_TOP_P: f32 = 1.0;
/// `top_k` floor. Zero is not "no filtering", it is "sample from no tokens".
pub const MIN_TOP_K: u32 = 1;
/// `top_k` ceiling. Chosen above every current model vocabulary (Gemma's 256k
/// is the largest), so the cap cannot clip a setting that would have changed
/// sampling: a `top_k` at or beyond the vocabulary filters nothing.
pub const MAX_TOP_K: u32 = 1_000_000;
/// Bounds for `frequency_penalty` and `presence_penalty`, which OpenAI
/// documents as −2.0…2.0 and rejects outside.
///
/// Both ends are spelled as literals rather than one negating the other, so
/// that each can be read without evaluating an expression. A test below pins
/// them as a symmetric pair, which is what the negation used to guarantee.
pub const MIN_SAMPLING_PENALTY: f32 = -2.0;
pub const MAX_SAMPLING_PENALTY: f32 = 2.0;
/// OpenAI accepts at most four `stop` sequences, so four is the most that can
/// be honoured by every protocol that takes them.
pub const MAX_STOP_SEQUENCES: usize = 4;
/// An empty stop sequence is refused by OpenAI, so one byte is the floor.
pub const MIN_STOP_SEQUENCE_BYTES: usize = 1;
pub const MAX_STOP_SEQUENCE_BYTES: usize = 128;
/// Floor for a per-request HTTP timeout. Below a second, a timeout cancels
/// requests that were going to succeed.
pub const MIN_REQUEST_TIMEOUT_MS: u32 = 1_000;
pub const MAX_REQUEST_TIMEOUT_MS: u32 = 600_000;

pub const STREAM_CHANNEL_CAPACITY: usize = 64;
pub const MAX_STREAM_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_STREAM_LINE_BYTES: usize = 256 * 1024;
pub const MAX_STREAM_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_STREAM_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RESPONSE_BODY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

fn limit_error(resource: &'static str, limit: usize, actual: usize) -> AiProviderError {
    AiProviderError::LimitExceeded {
        resource,
        limit,
        actual,
    }
}

pub fn validate_string(
    resource: &'static str,
    value: &str,
    limit: usize,
) -> Result<(), AiProviderError> {
    if value.len() > limit {
        return Err(limit_error(resource, limit, value.len()));
    }
    Ok(())
}

struct LimitWriter {
    resource: &'static str,
    limit: usize,
    written: usize,
    exceeded_at: Option<usize>,
}

impl Write for LimitWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let actual = self.written.saturating_add(buf.len());
        if actual > self.limit {
            self.exceeded_at = Some(actual);
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                format!(
                    "{} exceeded {} bytes at {actual}",
                    self.resource, self.limit
                ),
            ));
        }
        self.written = actual;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn serialized_len_limited<T: Serialize>(
    resource: &'static str,
    value: &T,
    limit: usize,
) -> Result<usize, AiProviderError> {
    let mut writer = LimitWriter {
        resource,
        limit,
        written: 0,
        exceeded_at: None,
    };
    if serde_json::to_writer(&mut writer, value).is_err() {
        return Err(limit_error(
            resource,
            limit,
            writer
                .exceeded_at
                .unwrap_or_else(|| writer.written.saturating_add(1)),
        ));
    }
    Ok(writer.written)
}

/// Vet stop sequences against what *every* protocol that takes them accepts.
///
/// The rules are deliberately the intersection rather than the union, because
/// the same configuration is sent to whichever provider is selected:
/// - OpenAI rejects an empty string;
/// - Anthropic rejects a sequence with no non-whitespace character, which also
///   rules out the whitespace-only `"\n\n"` form;
/// - `\n`, `\r` and `\t` stay legal inside a sequence, because `"\nUser:"` is
///   the canonical use of the knob and JSON carries those three losslessly.
///   Every other control character is refused: it cannot be typed deliberately
///   and would otherwise ride into a provider body unseen.
pub fn validate_stop_sequences(stop: &[String]) -> Result<(), AiProviderError> {
    if stop.len() > MAX_STOP_SEQUENCES {
        return Err(limit_error(
            "stop sequences",
            MAX_STOP_SEQUENCES,
            stop.len(),
        ));
    }
    for (index, sequence) in stop.iter().enumerate() {
        if sequence.len() < MIN_STOP_SEQUENCE_BYTES {
            return Err(AiProviderError::InvalidRequest {
                field: "stop",
                message: format!(
                    "sequence {index} must contain at least {MIN_STOP_SEQUENCE_BYTES} byte"
                ),
            });
        }
        validate_string("stop sequence", sequence, MAX_STOP_SEQUENCE_BYTES)?;
        if !sequence.chars().any(|value| !value.is_whitespace()) {
            return Err(AiProviderError::InvalidRequest {
                field: "stop",
                message: format!("sequence {index} must contain a non-whitespace character"),
            });
        }
        if sequence
            .chars()
            .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
        {
            return Err(AiProviderError::InvalidRequest {
                field: "stop",
                message: format!(
                    "sequence {index} must not contain control characters other than newline or tab"
                ),
            });
        }
    }
    Ok(())
}

pub fn validate_message(message: &Message) -> Result<(), AiProviderError> {
    if let Some(id) = &message.tool_call_id {
        validate_string("message tool-call id", id, MAX_TOOL_CALL_ID_BYTES)?;
    }

    match &message.content {
        MessageContent::Text { text } => {
            validate_string("message text", text, MAX_MESSAGE_BYTES)?;
        }
        MessageContent::ToolResult {
            tool_call_id,
            content,
            ..
        } => {
            validate_string("tool-call id", tool_call_id, MAX_TOOL_CALL_ID_BYTES)?;
            validate_string("tool result", content, MAX_TOOL_RESULT_BYTES)?;
        }
        MessageContent::ToolUse { tool_calls } => {
            if tool_calls.len() > MAX_TOOL_CALLS_PER_MESSAGE {
                return Err(limit_error(
                    "tool calls per message",
                    MAX_TOOL_CALLS_PER_MESSAGE,
                    tool_calls.len(),
                ));
            }
            for tool_call in tool_calls {
                validate_string("tool-call id", &tool_call.id, MAX_TOOL_CALL_ID_BYTES)?;
                validate_string("tool name", &tool_call.name, MAX_TOOL_NAME_BYTES)?;
                serialized_len_limited(
                    "tool-call arguments",
                    &tool_call.arguments,
                    MAX_TOOL_ARGUMENT_BYTES,
                )?;
            }
        }
    }

    serialized_len_limited("message", message, MAX_MESSAGE_BYTES)?;
    Ok(())
}

pub fn validate_completion_request(request: &CompletionRequest) -> Result<(), AiProviderError> {
    if request.model.is_empty() {
        return Err(AiProviderError::InvalidRequest {
            field: "model",
            message: "must not be empty".into(),
        });
    }
    validate_string("model", &request.model, MAX_MODEL_BYTES)?;

    if request.messages.len() > MAX_REQUEST_MESSAGES {
        return Err(limit_error(
            "request messages",
            MAX_REQUEST_MESSAGES,
            request.messages.len(),
        ));
    }
    for message in &request.messages {
        validate_message(message)?;
    }

    if let Some(system) = &request.system {
        validate_string("system prompt", system, MAX_SYSTEM_PROMPT_BYTES)?;
    }
    if let Some(temperature) = request.temperature {
        if !temperature.is_finite() || !(MIN_TEMPERATURE..=MAX_TEMPERATURE).contains(&temperature) {
            return Err(AiProviderError::InvalidRequest {
                field: "temperature",
                message: format!(
                    "must be finite and between {MIN_TEMPERATURE} and {MAX_TEMPERATURE}"
                ),
            });
        }
    }
    if let Some(max_tokens) = request.max_tokens {
        if max_tokens == 0 || max_tokens > MAX_COMPLETION_TOKENS {
            return Err(AiProviderError::InvalidRequest {
                field: "maxTokens",
                message: format!("must be between 1 and {MAX_COMPLETION_TOKENS}"),
            });
        }
    }
    if let Some(top_p) = request.top_p {
        if !top_p.is_finite() || !(MIN_TOP_P..=MAX_TOP_P).contains(&top_p) {
            return Err(AiProviderError::InvalidRequest {
                field: "topP",
                message: format!("must be finite and between {MIN_TOP_P} and {MAX_TOP_P}"),
            });
        }
    }
    if let Some(top_k) = request.top_k {
        if !(MIN_TOP_K..=MAX_TOP_K).contains(&top_k) {
            return Err(AiProviderError::InvalidRequest {
                field: "topK",
                message: format!("must be between {MIN_TOP_K} and {MAX_TOP_K}"),
            });
        }
    }
    for (field, penalty) in [
        ("frequencyPenalty", request.frequency_penalty),
        ("presencePenalty", request.presence_penalty),
    ] {
        if let Some(penalty) = penalty {
            if !penalty.is_finite()
                || !(MIN_SAMPLING_PENALTY..=MAX_SAMPLING_PENALTY).contains(&penalty)
            {
                return Err(AiProviderError::InvalidRequest {
                    field,
                    message: format!(
                        "must be finite and between {MIN_SAMPLING_PENALTY} and {MAX_SAMPLING_PENALTY}"
                    ),
                });
            }
        }
    }
    if let Some(stop) = &request.stop {
        validate_stop_sequences(stop)?;
    }
    if let Some(timeout_ms) = request.timeout_ms {
        if !(MIN_REQUEST_TIMEOUT_MS..=MAX_REQUEST_TIMEOUT_MS).contains(&timeout_ms) {
            return Err(AiProviderError::InvalidRequest {
                field: "timeoutMs",
                message: format!(
                    "must be between {MIN_REQUEST_TIMEOUT_MS} and {MAX_REQUEST_TIMEOUT_MS}"
                ),
            });
        }
    }

    if let Some(tools) = &request.tools {
        if tools.len() > MAX_REQUEST_TOOLS {
            return Err(limit_error("request tools", MAX_REQUEST_TOOLS, tools.len()));
        }
        for tool in tools {
            validate_string("tool name", &tool.name, MAX_TOOL_NAME_BYTES)?;
            validate_string(
                "tool description",
                &tool.description,
                MAX_TOOL_DESCRIPTION_BYTES,
            )?;
            serialized_len_limited(
                "tool input schema",
                &tool.input_schema,
                MAX_TOOL_SCHEMA_BYTES,
            )?;
        }
    }

    serialized_len_limited("completion request", request, MAX_REQUEST_BYTES)?;
    Ok(())
}

pub fn validate_response_message(message: &Message) -> Result<(), AiProviderError> {
    match &message.content {
        MessageContent::Text { text } => {
            validate_string("response output", text, MAX_STREAM_OUTPUT_BYTES)
        }
        MessageContent::ToolUse { tool_calls } => {
            if tool_calls.len() > MAX_TOOL_CALLS_PER_MESSAGE {
                return Err(limit_error(
                    "response tool calls",
                    MAX_TOOL_CALLS_PER_MESSAGE,
                    tool_calls.len(),
                ));
            }
            for tool_call in tool_calls {
                validate_string("tool-call id", &tool_call.id, MAX_TOOL_CALL_ID_BYTES)?;
                validate_string("tool name", &tool_call.name, MAX_TOOL_NAME_BYTES)?;
                serialized_len_limited(
                    "tool-call arguments",
                    &tool_call.arguments,
                    MAX_TOOL_ARGUMENT_BYTES,
                )?;
            }
            Ok(())
        }
        MessageContent::ToolResult { content, .. } => {
            validate_string("tool result", content, MAX_TOOL_RESULT_BYTES)
        }
    }
}

pub fn parse_tool_arguments(arguments: &str) -> Result<Value, AiProviderError> {
    validate_string(
        "streamed tool-call arguments",
        arguments,
        MAX_TOOL_ARGUMENT_BYTES,
    )?;
    let source = if arguments.is_empty() {
        "{}"
    } else {
        arguments
    };
    serde_json::from_str(source).map_err(|error| {
        AiProviderError::Parse(format!(
            "complete tool-call arguments were invalid JSON: {error}"
        ))
    })
}

/// Apply a configured request timeout to a one-shot call.
///
/// reqwest's per-request timeout covers connect, headers *and* body, which is
/// exactly the bound a non-streaming completion wants.
pub(crate) fn with_total_timeout(
    builder: reqwest::RequestBuilder,
    timeout_ms: Option<u32>,
) -> reqwest::RequestBuilder {
    match timeout_ms {
        Some(ms) => builder.timeout(std::time::Duration::from_millis(u64::from(ms))),
        None => builder,
    }
}

/// Send a streaming request, bounding only the wait for the response head.
///
/// The same reqwest timeout would cover the response body, so a 30-second
/// setting would cut off a 60-second generation mid-sentence. The streamed
/// body stays bounded by [`MAX_STREAM_BYTES`] and by the turn's own
/// cancellation instead.
pub(crate) async fn send_head_bounded(
    builder: reqwest::RequestBuilder,
    timeout_ms: Option<u32>,
) -> Result<reqwest::Response, AiProviderError> {
    let Some(ms) = timeout_ms else {
        return builder.send().await.map_err(AiProviderError::Http);
    };
    tokio::time::timeout(
        std::time::Duration::from_millis(u64::from(ms)),
        builder.send(),
    )
    .await
    .map_err(|_| AiProviderError::Timeout { ms })?
    .map_err(AiProviderError::Http)
}

pub(crate) async fn read_body_limited(
    response: reqwest::Response,
    resource: &'static str,
    limit: usize,
) -> Result<Vec<u8>, AiProviderError> {
    let mut bytes = BoundedBytes::new(resource, limit);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(AiProviderError::Http)?;
        bytes.extend_from_slice(&chunk)?;
    }
    Ok(bytes.into_vec())
}

pub(crate) async fn read_error_body(
    response: reqwest::Response,
) -> Result<String, AiProviderError> {
    let bytes = read_body_limited(response, "provider error body", MAX_ERROR_BODY_BYTES).await?;
    String::from_utf8(bytes)
        .map_err(|error| AiProviderError::Parse(format!("error body was not UTF-8: {error}")))
}

pub(crate) async fn read_json_body(response: reqwest::Response) -> Result<Value, AiProviderError> {
    let bytes =
        read_body_limited(response, "provider response body", MAX_RESPONSE_BODY_BYTES).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| AiProviderError::Parse(format!("invalid response JSON: {error}")))
}

pub(crate) async fn send_delta(
    tx: &mpsc::Sender<StreamDelta>,
    delta: StreamDelta,
) -> Result<(), AiProviderError> {
    tx.send(delta).await.map_err(|_| AiProviderError::Cancelled)
}

pub(crate) struct BoundedString {
    resource: &'static str,
    limit: usize,
    value: String,
}

struct BoundedBytes {
    resource: &'static str,
    limit: usize,
    value: Vec<u8>,
}

impl BoundedBytes {
    fn new(resource: &'static str, limit: usize) -> Self {
        Self {
            resource,
            limit,
            value: Vec::new(),
        }
    }

    fn extend_from_slice(&mut self, value: &[u8]) -> Result<(), AiProviderError> {
        let actual = self.value.len().saturating_add(value.len());
        if actual > self.limit {
            return Err(limit_error(self.resource, self.limit, actual));
        }
        self.value.extend_from_slice(value);
        Ok(())
    }

    fn into_vec(self) -> Vec<u8> {
        self.value
    }
}

impl BoundedString {
    pub(crate) fn new(resource: &'static str, limit: usize) -> Self {
        Self {
            resource,
            limit,
            value: String::new(),
        }
    }

    pub(crate) fn push_str(&mut self, value: &str) -> Result<(), AiProviderError> {
        let actual = self.value.len().saturating_add(value.len());
        if actual > self.limit {
            return Err(limit_error(self.resource, self.limit, actual));
        }
        self.value.push_str(value);
        Ok(())
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.value
    }

    pub(crate) fn into_string(self) -> String {
        self.value
    }
}

pub(crate) struct StreamBudget {
    received: usize,
}

impl StreamBudget {
    pub(crate) fn new() -> Self {
        Self { received: 0 }
    }

    pub(crate) fn add(&mut self, bytes: usize) -> Result<(), AiProviderError> {
        let actual = self.received.saturating_add(bytes);
        if actual > MAX_STREAM_BYTES {
            return Err(limit_error("stream bytes", MAX_STREAM_BYTES, actual));
        }
        self.received = actual;
        Ok(())
    }
}

pub(crate) struct LineDecoder {
    buffer: Vec<u8>,
}

impl LineDecoder {
    pub(crate) fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, AiProviderError> {
        if chunk.len() > MAX_STREAM_CHUNK_BYTES {
            return Err(limit_error(
                "stream chunk",
                MAX_STREAM_CHUNK_BYTES,
                chunk.len(),
            ));
        }

        let mut lines = Vec::new();
        let mut start = 0;
        for (index, byte) in chunk.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            self.extend(&chunk[start..index])?;
            if self.buffer.last() == Some(&b'\r') {
                self.buffer.pop();
            }
            lines.push(self.take_line()?);
            start = index + 1;
        }
        self.extend(&chunk[start..])?;
        Ok(lines)
    }

    pub(crate) fn finish(mut self) -> Result<Option<String>, AiProviderError> {
        if self.buffer.is_empty() {
            return Ok(None);
        }
        if self.buffer.last() == Some(&b'\r') {
            self.buffer.pop();
        }
        self.take_line().map(Some)
    }

    fn extend(&mut self, bytes: &[u8]) -> Result<(), AiProviderError> {
        let actual = self.buffer.len().saturating_add(bytes.len());
        if actual > MAX_STREAM_LINE_BYTES {
            return Err(limit_error("stream line", MAX_STREAM_LINE_BYTES, actual));
        }
        self.buffer.extend_from_slice(bytes);
        Ok(())
    }

    fn take_line(&mut self) -> Result<String, AiProviderError> {
        let bytes = std::mem::take(&mut self.buffer);
        String::from_utf8(bytes)
            .map_err(|error| AiProviderError::Parse(format!("stream line was not UTF-8: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{Message, ToolDefinition};

    fn request_with_text(text: String) -> CompletionRequest {
        CompletionRequest {
            model: "test-model".into(),
            messages: vec![Message::user(text)],
            tools: None,
            temperature: Some(0.7),
            max_tokens: Some(128),
            system: None,
            top_p: None,
            top_k: None,
            stop: None,
            seed: None,
            frequency_penalty: None,
            presence_penalty: None,
            timeout_ms: None,
        }
    }

    #[test]
    fn request_text_accepts_exact_boundary_and_rejects_one_more() {
        validate_string(
            "message text",
            &"x".repeat(MAX_MESSAGE_BYTES),
            MAX_MESSAGE_BYTES,
        )
        .expect("exact text boundary");
        validate_completion_request(&request_with_text("x".repeat(MAX_MESSAGE_BYTES - 80)))
            .expect("message below serialized boundary");

        let error =
            validate_completion_request(&request_with_text("x".repeat(MAX_MESSAGE_BYTES + 1)))
                .expect_err("oversized message must fail");
        assert!(matches!(
            error,
            AiProviderError::LimitExceeded {
                resource: "message text",
                ..
            }
        ));
    }

    #[test]
    fn request_count_and_tool_schema_boundaries_are_enforced() {
        let mut request = request_with_text("ok".into());
        request.messages = (0..MAX_REQUEST_MESSAGES)
            .map(|_| Message::user("x"))
            .collect();
        validate_completion_request(&request).expect("exact message-count boundary");

        request.messages = (0..=MAX_REQUEST_MESSAGES)
            .map(|_| Message::user("x"))
            .collect();
        assert!(matches!(
            validate_completion_request(&request),
            Err(AiProviderError::LimitExceeded {
                resource: "request messages",
                ..
            })
        ));

        let schema_at_limit = json!({"value": "x".repeat(MAX_TOOL_SCHEMA_BYTES - 12)});
        let mut request = request_with_text("ok".into());
        request.tools = Some(vec![ToolDefinition {
            name: "bounded".into(),
            description: "test".into(),
            input_schema: schema_at_limit,
        }]);
        validate_completion_request(&request).expect("schema just below boundary");

        request.tools.as_mut().expect("tool")[0].input_schema =
            json!({"value": "x".repeat(MAX_TOOL_SCHEMA_BYTES)});
        assert!(matches!(
            validate_completion_request(&request),
            Err(AiProviderError::LimitExceeded {
                resource: "tool input schema",
                ..
            })
        ));
    }

    #[test]
    fn line_decoder_accepts_exact_line_and_rejects_huge_line_and_chunk() {
        let mut exact = LineDecoder::new();
        let lines = exact
            .push(&vec![b'x'; MAX_STREAM_LINE_BYTES])
            .expect("exact line limit");
        assert!(lines.is_empty());
        assert_eq!(
            exact.finish().expect("valid UTF-8").expect("tail").len(),
            MAX_STREAM_LINE_BYTES
        );

        let mut huge_line = LineDecoder::new();
        huge_line
            .push(&vec![b'x'; MAX_STREAM_CHUNK_BYTES])
            .expect("first bounded chunk");
        assert!(matches!(
            huge_line.push(b"x"),
            Err(AiProviderError::LimitExceeded {
                resource: "stream line",
                ..
            })
        ));

        let mut huge_chunk = LineDecoder::new();
        assert!(matches!(
            huge_chunk.push(&vec![b'x'; MAX_STREAM_CHUNK_BYTES + 1]),
            Err(AiProviderError::LimitExceeded {
                resource: "stream chunk",
                ..
            })
        ));
    }

    #[test]
    fn endless_stream_budget_is_bounded() {
        let mut budget = StreamBudget::new();
        for _ in 0..(MAX_STREAM_BYTES / 1024) {
            budget.add(1024).expect("at boundary");
        }
        assert!(matches!(
            budget.add(1),
            Err(AiProviderError::LimitExceeded {
                resource: "stream bytes",
                ..
            })
        ));
    }

    #[test]
    fn bounded_output_does_not_append_over_limit() {
        let mut output = BoundedString::new("response output", 4);
        output.push_str("four").expect("exact boundary");
        assert!(output.push_str("!").is_err());
        assert_eq!(output.as_str(), "four");
    }

    #[test]
    fn error_body_accepts_exact_boundary_and_rejects_before_growth() {
        let mut body = BoundedBytes::new("provider error body", MAX_ERROR_BODY_BYTES);
        body.extend_from_slice(&vec![b'x'; MAX_ERROR_BODY_BYTES])
            .expect("exact error body boundary");
        assert!(matches!(
            body.extend_from_slice(b"x"),
            Err(AiProviderError::LimitExceeded {
                resource: "provider error body",
                ..
            })
        ));
        assert_eq!(body.into_vec().len(), MAX_ERROR_BODY_BYTES);
    }

    /// The last gate before an advanced control reaches a provider body. The
    /// agent configuration validates the same ranges first; this is what stops
    /// a request assembled anywhere else from carrying a value the API rejects.
    #[test]
    fn advanced_control_boundaries_are_accepted_and_one_step_past_is_not() {
        let mut request = request_with_text("ok".into());
        request.top_p = Some(MAX_TOP_P);
        request.top_k = Some(MAX_TOP_K);
        request.frequency_penalty = Some(MAX_SAMPLING_PENALTY);
        request.presence_penalty = Some(MIN_SAMPLING_PENALTY);
        request.seed = Some(u32::MAX);
        request.stop = Some(vec![
            "x".repeat(MAX_STOP_SEQUENCE_BYTES);
            MAX_STOP_SEQUENCES
        ]);
        request.timeout_ms = Some(MAX_REQUEST_TIMEOUT_MS);
        validate_completion_request(&request).expect("exact advanced boundaries");

        request.timeout_ms = Some(MIN_REQUEST_TIMEOUT_MS);
        validate_completion_request(&request).expect("timeout floor");

        let out_of_range = [
            ("topP", {
                let mut invalid = request_with_text("ok".into());
                invalid.top_p = Some(MAX_TOP_P + 0.1);
                invalid
            }),
            ("topP", {
                let mut invalid = request_with_text("ok".into());
                invalid.top_p = Some(f32::NAN);
                invalid
            }),
            ("topP", {
                let mut invalid = request_with_text("ok".into());
                invalid.top_p = Some(MIN_TOP_P - 0.1);
                invalid
            }),
            ("temperature", {
                let mut invalid = request_with_text("ok".into());
                invalid.temperature = Some(MIN_TEMPERATURE - 0.1);
                invalid
            }),
            ("temperature", {
                let mut invalid = request_with_text("ok".into());
                invalid.temperature = Some(MAX_TEMPERATURE + 0.1);
                invalid
            }),
            ("topK", {
                let mut invalid = request_with_text("ok".into());
                invalid.top_k = Some(MIN_TOP_K - 1);
                invalid
            }),
            ("topK", {
                let mut invalid = request_with_text("ok".into());
                invalid.top_k = Some(MAX_TOP_K + 1);
                invalid
            }),
            ("frequencyPenalty", {
                let mut invalid = request_with_text("ok".into());
                invalid.frequency_penalty = Some(MAX_SAMPLING_PENALTY + 0.1);
                invalid
            }),
            ("presencePenalty", {
                let mut invalid = request_with_text("ok".into());
                invalid.presence_penalty = Some(MIN_SAMPLING_PENALTY - 0.1);
                invalid
            }),
            ("timeoutMs", {
                let mut invalid = request_with_text("ok".into());
                invalid.timeout_ms = Some(MIN_REQUEST_TIMEOUT_MS - 1);
                invalid
            }),
            ("timeoutMs", {
                let mut invalid = request_with_text("ok".into());
                invalid.timeout_ms = Some(MAX_REQUEST_TIMEOUT_MS + 1);
                invalid
            }),
        ];
        for (name, invalid) in out_of_range {
            match validate_completion_request(&invalid) {
                Err(AiProviderError::InvalidRequest { field, .. }) => assert_eq!(field, name),
                other => panic!("{name} out of range must be refused, got {other:?}"),
            }
        }

        let mut invalid = request_with_text("ok".into());
        invalid.stop = Some(vec!["x".into(); MAX_STOP_SEQUENCES + 1]);
        assert!(matches!(
            validate_completion_request(&invalid),
            Err(AiProviderError::LimitExceeded {
                resource: "stop sequences",
                ..
            })
        ));
    }

    /// The penalty bounds used to be `-MAX..=MAX`, which made symmetry
    /// structural. They are two literals now so each can be read without
    /// evaluating an expression, so the symmetry needs pinning instead.
    #[test]
    fn the_sampling_penalty_bounds_stay_a_symmetric_pair() {
        assert_eq!(MIN_SAMPLING_PENALTY, -MAX_SAMPLING_PENALTY);
    }

    /// A stop sequence is user text that ends up inside a provider body, and
    /// the rules are the intersection of the three protocols rather than any
    /// one of them — see [`validate_stop_sequences`].
    #[test]
    fn stop_sequences_keep_newlines_but_refuse_empty_blank_and_control_text() {
        validate_stop_sequences(&["\nUser:".into(), "END\t".into(), "\r\n#".into()])
            .expect("newline-bearing sequences are the common case");

        for refused in [
            "",
            "\n\n",
            "   ",
            "stop\u{0}",
            "stop\u{1b}[0m",
            &"x".repeat(MAX_STOP_SEQUENCE_BYTES + 1),
        ] {
            assert!(
                validate_stop_sequences(&[refused.to_string()]).is_err(),
                "stop sequence {refused:?} must be refused"
            );
        }
    }

    #[test]
    fn malformed_complete_tool_arguments_are_not_replaced_or_truncated() {
        let error = parse_tool_arguments("{\"unterminated\":")
            .expect_err("partial JSON must remain an explicit error");
        assert!(matches!(error, AiProviderError::Parse(_)));
    }
}
