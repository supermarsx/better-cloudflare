//! Core agent loop with bounded channels and lifecycle-aware cancellation.

use std::future::Future;

use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use bc_ai_chat::{ChatManager, ChatMessage, MessageStatus};
use bc_ai_provider::limits::{
    validate_string, MAX_ERROR_BODY_BYTES, MAX_TOOL_RESULT_BYTES, STREAM_CHANNEL_CAPACITY,
};
use bc_ai_provider::*;
use bc_ai_tools::executor::{ExecutionResult, ToolExecutor};
use bc_ai_tools::ToolRegistry;

use crate::config::AgentConfig;
use crate::error::AgentError;
use crate::events::AgentEvent;

async fn lifecycle_termination(
    cancellation: &mut watch::Receiver<bool>,
    disposal: &mut watch::Receiver<bool>,
    event_tx: &mpsc::Sender<AgentEvent>,
    conversation_id: Uuid,
) -> AgentError {
    if *cancellation.borrow() {
        return AgentError::Cancelled;
    }
    if *disposal.borrow() {
        return AgentError::ConversationDisposed(conversation_id);
    }

    loop {
        tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    return AgentError::Cancelled;
                }
            }
            changed = disposal.changed() => {
                if changed.is_err() || *disposal.borrow() {
                    return AgentError::ConversationDisposed(conversation_id);
                }
            }
            _ = event_tx.closed() => {
                return AgentError::ConsumerDropped;
            }
        }
    }
}

async fn until_lifecycle<F, T>(
    future: F,
    cancellation: &mut watch::Receiver<bool>,
    disposal: &mut watch::Receiver<bool>,
    event_tx: &mpsc::Sender<AgentEvent>,
    conversation_id: Uuid,
) -> Result<T, AgentError>
where
    F: Future<Output = T>,
{
    tokio::pin!(future);
    tokio::select! {
        output = &mut future => Ok(output),
        error = lifecycle_termination(cancellation, disposal, event_tx, conversation_id) => {
            Err(error)
        }
    }
}

async fn send_event(
    event_tx: &mpsc::Sender<AgentEvent>,
    event: AgentEvent,
    cancellation: &mut watch::Receiver<bool>,
    disposal: &mut watch::Receiver<bool>,
    conversation_id: Uuid,
) -> Result<(), AgentError> {
    until_lifecycle(
        event_tx.send(event),
        cancellation,
        disposal,
        event_tx,
        conversation_id,
    )
    .await?
    .map_err(|_| AgentError::ConsumerDropped)
}

async fn forward_stream(
    mut stream_rx: mpsc::Receiver<StreamDelta>,
    event_tx: &mpsc::Sender<AgentEvent>,
    conversation_id: Uuid,
    message_id: Uuid,
) -> Result<(), AgentError> {
    while let Some(delta) = stream_rx.recv().await {
        let event = match delta {
            StreamDelta::Text { text } => Some(AgentEvent::TextDelta {
                conversation_id,
                message_id,
                text,
            }),
            StreamDelta::ToolCallStart { id, name } => Some(AgentEvent::ToolCallStart {
                conversation_id,
                tool_call_id: id,
                tool_name: name,
            }),
            StreamDelta::Usage(usage) => Some(AgentEvent::UsageUpdate {
                conversation_id,
                usage,
            }),
            StreamDelta::Error { message } => {
                return Err(AgentError::Provider(AiProviderError::Other(message)));
            }
            StreamDelta::ToolCallDelta { .. }
            | StreamDelta::ToolCallEnd { .. }
            | StreamDelta::Done => None,
        };
        if let Some(event) = event {
            event_tx
                .send(event)
                .await
                .map_err(|_| AgentError::ConsumerDropped)?;
        }
    }
    Ok(())
}

async fn stream_completion(
    provider: &dyn AiProvider,
    request: CompletionRequest,
    event_tx: &mpsc::Sender<AgentEvent>,
    conversation_id: Uuid,
    message_id: Uuid,
) -> Result<CompletionResponse, AgentError> {
    let (stream_tx, stream_rx) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
    let provider_future = provider.stream(request, stream_tx);
    let consumer_future = forward_stream(stream_rx, event_tx, conversation_id, message_id);
    let (response, ()) = tokio::try_join!(
        async { provider_future.await.map_err(AgentError::from) },
        consumer_future
    )?;
    Ok(response)
}

pub(crate) fn tool_result_message(result: bc_ai_provider::ToolResult) -> ChatMessage {
    ChatMessage {
        id: Uuid::new_v4(),
        message: Message::tool_result(result.tool_call_id, result.content, result.is_error),
        status: MessageStatus::Complete,
        created_at: chrono::Utc::now(),
        usage: None,
        pending_tool_calls: Vec::new(),
    }
}

async fn execute_tool_calls(
    tool_calls: &[ToolCall],
    executor: &ToolExecutor,
    chat: &ChatManager,
    conversation_id: Uuid,
    event_tx: &mpsc::Sender<AgentEvent>,
    cancellation: &mut watch::Receiver<bool>,
    disposal: &mut watch::Receiver<bool>,
) -> Result<bool, AgentError> {
    for tool_call in tool_calls {
        let result = until_lifecycle(
            executor.execute(tool_call, false),
            cancellation,
            disposal,
            event_tx,
            conversation_id,
        )
        .await?;

        match result {
            // A refusal is a result like any other: the model is told the call
            // was refused, in the same turn, so it can answer the user instead
            // of stalling or retrying. Because the round continues normally,
            // refused calls count against `max_tool_rounds`.
            ExecutionResult::Success(result)
            | ExecutionResult::Error(result)
            | ExecutionResult::Denied(result) => {
                if result.content.len() > MAX_TOOL_RESULT_BYTES {
                    return Err(AgentError::ToolOutputLimit {
                        limit: MAX_TOOL_RESULT_BYTES,
                        actual: result.content.len(),
                    });
                }
                send_event(
                    event_tx,
                    AgentEvent::ToolCallComplete {
                        conversation_id,
                        tool_call_id: tool_call.id.clone(),
                        tool_name: tool_call.name.clone(),
                        result: result.content.clone(),
                        is_error: result.is_error,
                    },
                    cancellation,
                    disposal,
                    conversation_id,
                )
                .await?;
                chat.try_push_message(conversation_id, tool_result_message(result))
                    .await?;
            }
            ExecutionResult::NeedsApproval { tool_call, reason } => {
                validate_string("tool approval reason", &reason, MAX_ERROR_BODY_BYTES)?;
                let pending = tool_call.clone();
                chat.try_update_last_assistant_message(conversation_id, |message| {
                    message.pending_tool_calls.push(pending);
                })
                .await?;
                send_event(
                    event_tx,
                    AgentEvent::ToolApprovalRequired {
                        conversation_id,
                        tool_call_id: tool_call.id,
                        tool_name: tool_call.name,
                        arguments: tool_call.arguments,
                        reason,
                    },
                    cancellation,
                    disposal,
                    conversation_id,
                )
                .await?;
                return Ok(true);
            }
            ExecutionResult::Rejected(error) => return Err(error.into()),
        }
    }
    Ok(false)
}

/// Run one agentic turn until final text, approval pause, cancellation, or error.
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    provider: &dyn AiProvider,
    chat: &ChatManager,
    registry: &ToolRegistry,
    executor: &ToolExecutor,
    config: &AgentConfig,
    persona_prompt: Option<String>,
    conversation_id: Uuid,
    event_tx: mpsc::Sender<AgentEvent>,
    mut cancellation: watch::Receiver<bool>,
    mut disposal: watch::Receiver<bool>,
) -> Result<Uuid, AgentError> {
    config.validate()?;
    // A prompt chosen for this conversation wins; the configured persona is
    // the fallback, so selecting one actually changes how the agent behaves.
    let system_prompt = chat.system_prompt(conversation_id).await.or(persona_prompt);
    let model = chat
        .model(conversation_id)
        .await
        .ok_or(bc_ai_chat::ChatError::ConversationNotFound(conversation_id))?;
    let tools = if config.tools_enabled {
        Some(registry.definitions().await)
    } else {
        None
    };

    for _round in 0..config.max_tool_rounds {
        let messages = chat
            .provider_messages(conversation_id)
            .await
            .ok_or(bc_ai_chat::ChatError::ConversationNotFound(conversation_id))?;
        let request = CompletionRequest {
            model: model.clone(),
            messages,
            system: system_prompt.clone(),
            temperature: Some(config.temperature),
            max_tokens: Some(config.max_tokens_per_turn),
            tools: tools.clone(),
        };

        let assistant_message = ChatMessage::assistant_pending();
        let message_id = assistant_message.id;
        chat.try_push_message(conversation_id, assistant_message)
            .await?;

        let response_result = if config.stream {
            until_lifecycle(
                stream_completion(provider, request, &event_tx, conversation_id, message_id),
                &mut cancellation,
                &mut disposal,
                &event_tx,
                conversation_id,
            )
            .await
            .and_then(|result| result)
        } else {
            until_lifecycle(
                provider.complete(request),
                &mut cancellation,
                &mut disposal,
                &event_tx,
                conversation_id,
            )
            .await
            .and_then(|result| result.map_err(AgentError::from))
        };
        let response = match response_result {
            Ok(response) => response,
            Err(error) => {
                let status = if matches!(error, AgentError::Cancelled) {
                    MessageStatus::Cancelled
                } else {
                    MessageStatus::Error {
                        message: error.public_message(),
                    }
                };
                let _ = chat
                    .try_update_last_assistant_message(conversation_id, |message| {
                        message.status = status;
                    })
                    .await;
                return Err(error);
            }
        };

        let response_message = response.message.clone();
        let response_usage = response.usage.clone();
        if !chat
            .try_update_last_assistant_message(conversation_id, |message| {
                message.message = response_message;
                message.status = MessageStatus::Complete;
                message.usage = response_usage;
            })
            .await?
        {
            return Err(AgentError::Chat(
                bc_ai_chat::ChatError::ConversationNotFound(conversation_id),
            ));
        }

        if let MessageContent::ToolUse { tool_calls } = response.message.content {
            let paused = execute_tool_calls(
                &tool_calls,
                executor,
                chat,
                conversation_id,
                &event_tx,
                &mut cancellation,
                &mut disposal,
            )
            .await?;
            if paused {
                return Ok(message_id);
            }
            continue;
        }

        send_event(
            &event_tx,
            AgentEvent::TurnComplete {
                conversation_id,
                message_id,
            },
            &mut cancellation,
            &mut disposal,
            conversation_id,
        )
        .await?;
        return Ok(message_id);
    }

    Err(AgentError::ToolRoundLimit(config.max_tool_rounds))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use bc_ai_provider::{AiProviderError, Model, Role};
    use bc_ai_tools::permissions::{
        AiPermissionMode, AiPermissions, AiToolPermission, PERMISSION_REFUSAL_PREFIX,
    };

    use super::*;

    const READ_TOOL: &str = "dns_parse_spf";
    const WRITE_TOOL: &str = "cf_delete_dns_record";

    /// Asks for the same tool on every round, like a model that will not take
    /// a refusal for an answer.
    struct ToolLoopProvider {
        tool_name: &'static str,
        rounds: Arc<AtomicUsize>,
    }

    impl ToolLoopProvider {
        fn new(tool_name: &'static str) -> Self {
            Self {
                tool_name,
                rounds: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn response(&self) -> CompletionResponse {
            let round = self.rounds.fetch_add(1, Ordering::SeqCst);
            CompletionResponse {
                message: Message {
                    role: Role::Assistant,
                    content: MessageContent::ToolUse {
                        tool_calls: vec![ToolCall {
                            id: format!("call-{round}"),
                            name: self.tool_name.into(),
                            arguments: serde_json::json!({ "content": "v=spf1 -all" }),
                        }],
                    },
                    tool_call_id: None,
                },
                usage: None,
                model: "mock".into(),
                finish_reason: Some("tool_use".into()),
            }
        }
    }

    #[async_trait]
    impl AiProvider for ToolLoopProvider {
        fn kind(&self) -> &str {
            "mock"
        }

        async fn complete(
            &self,
            _request: CompletionRequest,
        ) -> Result<CompletionResponse, AiProviderError> {
            Ok(self.response())
        }

        async fn stream(
            &self,
            _request: CompletionRequest,
            _tx: mpsc::Sender<StreamDelta>,
        ) -> Result<CompletionResponse, AiProviderError> {
            Ok(self.response())
        }

        async fn list_models(&self) -> Result<Vec<Model>, AiProviderError> {
            Ok(Vec::new())
        }

        async fn health_check(&self) -> Result<(), AiProviderError> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct CapturingProvider {
        request: std::sync::Mutex<Option<CompletionRequest>>,
    }

    #[async_trait]
    impl AiProvider for CapturingProvider {
        fn kind(&self) -> &str {
            "mock"
        }

        async fn complete(
            &self,
            request: CompletionRequest,
        ) -> Result<CompletionResponse, AiProviderError> {
            *self.request.lock().expect("request") = Some(request);
            Ok(CompletionResponse {
                message: Message::assistant("done"),
                usage: None,
                model: "mock".into(),
                finish_reason: Some("stop".into()),
            })
        }

        async fn stream(
            &self,
            request: CompletionRequest,
            _tx: mpsc::Sender<StreamDelta>,
        ) -> Result<CompletionResponse, AiProviderError> {
            self.complete(request).await
        }

        async fn list_models(&self) -> Result<Vec<Model>, AiProviderError> {
            Ok(Vec::new())
        }

        async fn health_check(&self) -> Result<(), AiProviderError> {
            Ok(())
        }
    }

    struct Harness {
        chat: ChatManager,
        registry: Arc<ToolRegistry>,
        executor: ToolExecutor,
        conversation_id: Uuid,
    }

    impl Harness {
        async fn new(permissions: AiPermissions) -> Self {
            let chat = ChatManager::default();
            let conversation_id = chat
                .try_create_conversation(
                    bc_ai_provider::ProviderKind::Ollama,
                    "mock".into(),
                    None,
                    None,
                )
                .await
                .expect("conversation")
                .id;
            chat.try_push_message(conversation_id, ChatMessage::user("do the thing"))
                .await
                .expect("user message");

            let registry = Arc::new(ToolRegistry::default());
            registry.init_all().await;
            let executor = ToolExecutor::with_registry(Arc::clone(&registry));
            executor
                .try_set_permissions(permissions)
                .await
                .expect("valid permissions");

            Self {
                chat,
                registry,
                executor,
                conversation_id,
            }
        }

        async fn run(
            &self,
            provider: &dyn AiProvider,
            config: &AgentConfig,
            persona_prompt: Option<String>,
        ) -> Result<Uuid, AgentError> {
            let disposal = self
                .chat
                .subscribe_disposal(self.conversation_id)
                .await
                .expect("disposal subscription");
            let (_cancellation_tx, cancellation_rx) = watch::channel(false);
            let (event_tx, _event_rx) = mpsc::channel(256);
            run_turn(
                provider,
                &self.chat,
                self.registry.as_ref(),
                &self.executor,
                config,
                persona_prompt,
                self.conversation_id,
                event_tx,
                cancellation_rx,
                disposal,
            )
            .await
        }

        async fn tool_results(&self) -> Vec<(String, bool)> {
            self.chat
                .get_conversation(self.conversation_id)
                .await
                .expect("conversation")
                .messages
                .iter()
                .filter_map(|message| match &message.message.content {
                    MessageContent::ToolResult {
                        content, is_error, ..
                    } => Some((content.clone(), *is_error)),
                    _ => None,
                })
                .collect()
        }
    }

    fn config(max_tool_rounds: u32) -> AgentConfig {
        AgentConfig {
            max_tool_rounds,
            stream: false,
            ..AgentConfig::default()
        }
    }

    /// The point of the feature: a denied call does not run, the model is told
    /// so, and the refusals are bounded by the existing round limit instead of
    /// letting the model spin forever.
    #[tokio::test]
    async fn denied_tool_calls_are_refused_fed_back_and_consume_tool_rounds() {
        let harness = Harness::new(AiPermissions {
            mode: AiPermissionMode::ReadOnly,
            tools: BTreeMap::new(),
        })
        .await;
        let provider = ToolLoopProvider::new(WRITE_TOOL);
        let rounds = 3;

        let error = harness
            .run(&provider, &config(rounds), None)
            .await
            .expect_err("a model that only calls denied tools must hit the round limit");

        assert!(matches!(error, AgentError::ToolRoundLimit(limit) if limit == rounds));
        assert_eq!(provider.rounds.load(Ordering::SeqCst), rounds as usize);

        let results = harness.tool_results().await;
        assert_eq!(results.len(), rounds as usize);
        for (content, is_error) in results {
            assert!(
                content.starts_with(PERMISSION_REFUSAL_PREFIX),
                "the model must be told the call was refused: {content}"
            );
            assert!(content.contains("read-only"));
            assert!(is_error);
        }
    }

    #[tokio::test]
    async fn an_explicit_deny_refuses_a_read_tool_too() {
        let harness = Harness::new(AiPermissions {
            mode: AiPermissionMode::Autonomous,
            tools: BTreeMap::from([(READ_TOOL.to_string(), AiToolPermission::Deny)]),
        })
        .await;
        let provider = ToolLoopProvider::new(READ_TOOL);

        let error = harness
            .run(&provider, &config(1), None)
            .await
            .expect_err("round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(1)));
        let (content, is_error) = harness
            .tool_results()
            .await
            .pop()
            .expect("one refusal was recorded");
        assert!(content.starts_with(PERMISSION_REFUSAL_PREFIX));
        assert!(is_error);
    }

    /// The counterpart: a permitted call is *not* refused by us. In-process MCP
    /// dispatch is denied without canonical grants, so what this pins is that
    /// the permission gate passed the call through to the dispatch boundary.
    #[tokio::test]
    async fn a_permitted_tool_call_reaches_dispatch() {
        let harness = Harness::new(AiPermissions {
            mode: AiPermissionMode::Ask,
            tools: BTreeMap::new(),
        })
        .await;
        let provider = ToolLoopProvider::new(READ_TOOL);

        let error = harness
            .run(&provider, &config(1), None)
            .await
            .expect_err("round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(1)));
        let (content, _) = harness
            .tool_results()
            .await
            .pop()
            .expect("the call produced a result");
        assert!(
            !content.starts_with(PERMISSION_REFUSAL_PREFIX),
            "a permitted read tool must not be refused: {content}"
        );
    }

    #[tokio::test]
    async fn a_tool_needing_approval_pauses_the_turn_without_a_result() {
        let harness = Harness::new(AiPermissions {
            mode: AiPermissionMode::Ask,
            tools: BTreeMap::new(),
        })
        .await;
        let provider = ToolLoopProvider::new(WRITE_TOOL);

        harness
            .run(&provider, &config(3), None)
            .await
            .expect("the turn pauses for approval rather than failing");
        assert_eq!(provider.rounds.load(Ordering::SeqCst), 1);
        assert!(
            harness.tool_results().await.is_empty(),
            "a paused call has no result yet"
        );
    }

    #[tokio::test]
    async fn disabling_tool_use_refuses_calls_the_model_makes_anyway() {
        let harness = Harness::new(AiPermissions {
            mode: AiPermissionMode::Autonomous,
            tools: BTreeMap::new(),
        })
        .await;
        harness.executor.set_tools_enabled(false).await;
        let provider = ToolLoopProvider::new(READ_TOOL);

        let mut config = config(1);
        config.tools_enabled = false;
        let error = harness
            .run(&provider, &config, None)
            .await
            .expect_err("round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(1)));
        let (content, _) = harness
            .tool_results()
            .await
            .pop()
            .expect("the refusal was recorded");
        assert!(content.contains("disabled"));
    }

    #[tokio::test]
    async fn the_configured_persona_prompt_and_temperature_reach_the_provider() {
        let harness = Harness::new(AiPermissions::default()).await;
        let provider = CapturingProvider::default();

        harness
            .run(&provider, &config(2), Some("You are the persona.".into()))
            .await
            .expect("plain text turn completes");

        let request = provider
            .request
            .lock()
            .expect("request")
            .clone()
            .expect("the provider was called");
        assert_eq!(request.system.as_deref(), Some("You are the persona."));
        assert_eq!(
            request.temperature,
            Some(AgentConfig::default().temperature)
        );
    }

    #[tokio::test]
    async fn a_conversation_prompt_outranks_the_persona_prompt() {
        let harness = Harness::new(AiPermissions::default()).await;
        let conversation_id = harness
            .chat
            .try_create_conversation(
                bc_ai_provider::ProviderKind::Ollama,
                "mock".into(),
                None,
                Some("Conversation prompt.".into()),
            )
            .await
            .expect("conversation")
            .id;
        harness
            .chat
            .try_push_message(conversation_id, ChatMessage::user("hi"))
            .await
            .expect("user message");

        let provider = CapturingProvider::default();
        let disposal = harness
            .chat
            .subscribe_disposal(conversation_id)
            .await
            .expect("disposal subscription");
        let (_cancellation_tx, cancellation_rx) = watch::channel(false);
        let (event_tx, _event_rx) = mpsc::channel(256);

        run_turn(
            &provider,
            &harness.chat,
            harness.registry.as_ref(),
            &harness.executor,
            &config(2),
            Some("You are the persona.".into()),
            conversation_id,
            event_tx,
            cancellation_rx,
            disposal,
        )
        .await
        .expect("turn completes");

        let request = provider
            .request
            .lock()
            .expect("request")
            .clone()
            .expect("the provider was called");
        assert_eq!(request.system.as_deref(), Some("Conversation prompt."));
    }
}
