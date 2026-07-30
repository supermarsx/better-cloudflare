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

fn tool_result_message(result: bc_ai_provider::ToolResult) -> ChatMessage {
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
            ExecutionResult::Success(result) | ExecutionResult::Error(result) => {
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
    conversation_id: Uuid,
    event_tx: mpsc::Sender<AgentEvent>,
    mut cancellation: watch::Receiver<bool>,
    mut disposal: watch::Receiver<bool>,
) -> Result<Uuid, AgentError> {
    config.validate()?;
    let system_prompt = chat.system_prompt(conversation_id).await;
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
            temperature: None,
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
