//! Core agent loop: the agentic cycle of LLM calls + tool execution.

use tokio::sync::mpsc;
use uuid::Uuid;

use bc_ai_chat::{ChatManager, ChatMessage, MessageStatus};
use bc_ai_provider::*;
use bc_ai_tools::executor::{ExecutionResult, ToolExecutor};
use bc_ai_tools::ToolRegistry;

use crate::config::AgentConfig;
use crate::events::AgentEvent;

/// Run one agentic turn: send user message → stream response → execute tools → loop.
///
/// Returns when the assistant produces a final text response (no more tool
/// calls) or the max tool rounds are exceeded.
pub async fn run_turn(
    provider: &dyn AiProvider,
    chat: &ChatManager,
    registry: &ToolRegistry,
    executor: &ToolExecutor,
    config: &AgentConfig,
    conversation_id: Uuid,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
) -> Result<Uuid, String> {
    let system_prompt = chat.system_prompt(conversation_id).await;

    // Create a pending assistant message
    let assistant_msg = ChatMessage::assistant_pending();
    let message_id = assistant_msg.id;
    chat.push_message(conversation_id, assistant_msg).await;

    let tools = if config.tools_enabled {
        Some(registry.definitions().await)
    } else {
        None
    };

    let mut rounds = 0u32;

    loop {
        rounds += 1;
        if rounds > config.max_tool_rounds {
            let _ = event_tx.send(AgentEvent::Error {
                conversation_id,
                error: format!("Exceeded max tool rounds ({})", config.max_tool_rounds),
            });
            break;
        }

        let messages = chat
            .provider_messages(conversation_id)
            .await
            .ok_or("Conversation not found")?;

        let request = CompletionRequest {
            model: String::new(), // Filled by provider config
            messages,
            system: system_prompt.clone(),
            temperature: None,
            max_tokens: Some(config.max_tokens_per_turn),
            tools: tools.clone(),
        };

        if config.stream {
            let (tx, mut rx) = mpsc::channel(128);

            // Spawn stream consumer
            let event_tx_clone = event_tx.clone();
            let conv_id = conversation_id;
            let msg_id = message_id;
            let stream_handle = tokio::spawn(async move {
                let mut full_text = String::new();
                while let Some(delta) = rx.recv().await {
                    match &delta {
                        StreamDelta::Text { text } => {
                            full_text.push_str(text);
                            let _ = event_tx_clone.send(AgentEvent::TextDelta {
                                conversation_id: conv_id,
                                message_id: msg_id,
                                text: text.clone(),
                            });
                        }
                        StreamDelta::ToolCallStart { id, name } => {
                            let _ = event_tx_clone.send(AgentEvent::ToolCallStart {
                                conversation_id: conv_id,
                                tool_call_id: id.clone(),
                                tool_name: name.clone(),
                            });
                        }
                        StreamDelta::Usage(usage) => {
                            let _ = event_tx_clone.send(AgentEvent::UsageUpdate {
                                conversation_id: conv_id,
                                usage: usage.clone(),
                            });
                        }
                        _ => {}
                    }
                }
                full_text
            });

            let result = provider.stream(request, tx).await.map_err(|e| e.to_string())?;
            let _full_text = stream_handle.await.unwrap_or_default();

            // Update the assistant message
            let response = result;
            chat.update_last_assistant_message(conversation_id, |msg| {
                msg.message = response.message.clone();
                msg.status = MessageStatus::Complete;
                msg.usage = response.usage.clone();
            })
            .await;

            // Check if there are tool calls
            if let MessageContent::ToolUse { ref tool_calls } = response.message.content {
                let tool_results =
                    execute_tool_calls(tool_calls, executor, conversation_id, &event_tx).await;

                // Add tool results as messages
                for tr in tool_results {
                    match tr {
                        ExecutionResult::Success(result) => {
                            let msg = ChatMessage {
                                id: Uuid::new_v4(),
                                message: Message::tool_result(
                                    result.tool_call_id,
                                    result.content,
                                    result.is_error,
                                ),
                                status: MessageStatus::Complete,
                                created_at: chrono::Utc::now(),
                                usage: None,
                                pending_tool_calls: Vec::new(),
                            };
                            chat.push_message(conversation_id, msg).await;
                        }
                        ExecutionResult::NeedsApproval { tool_call, reason } => {
                            let _ = event_tx.send(AgentEvent::ToolApprovalRequired {
                                conversation_id,
                                tool_call_id: tool_call.id.clone(),
                                tool_name: tool_call.name.clone(),
                                arguments: tool_call.arguments.clone(),
                                reason,
                            });
                            // Pause the loop — the manager will resume after approval
                            return Ok(message_id);
                        }
                        ExecutionResult::Error(result) => {
                            let msg = ChatMessage {
                                id: Uuid::new_v4(),
                                message: Message::tool_result(
                                    result.tool_call_id,
                                    result.content,
                                    result.is_error,
                                ),
                                status: MessageStatus::Complete,
                                created_at: chrono::Utc::now(),
                                usage: None,
                                pending_tool_calls: Vec::new(),
                            };
                            chat.push_message(conversation_id, msg).await;
                        }
                    }
                }

                // Continue the loop — the next iteration will call the LLM
                // with the tool results included in the conversation.
                continue;
            }
        } else {
            // Non-streaming
            let response = provider.complete(request).await.map_err(|e| e.to_string())?;

            chat.update_last_assistant_message(conversation_id, |msg| {
                msg.message = response.message.clone();
                msg.status = MessageStatus::Complete;
                msg.usage = response.usage.clone();
            })
            .await;

            if let MessageContent::ToolUse { ref tool_calls } = response.message.content {
                let tool_results =
                    execute_tool_calls(tool_calls, executor, conversation_id, &event_tx).await;

                for tr in tool_results {
                    match tr {
                        ExecutionResult::Success(result) | ExecutionResult::Error(result) => {
                            let msg = ChatMessage {
                                id: Uuid::new_v4(),
                                message: Message::tool_result(
                                    result.tool_call_id,
                                    result.content,
                                    result.is_error,
                                ),
                                status: MessageStatus::Complete,
                                created_at: chrono::Utc::now(),
                                usage: None,
                                pending_tool_calls: Vec::new(),
                            };
                            chat.push_message(conversation_id, msg).await;
                        }
                        ExecutionResult::NeedsApproval { tool_call, reason } => {
                            let _ = event_tx.send(AgentEvent::ToolApprovalRequired {
                                conversation_id,
                                tool_call_id: tool_call.id.clone(),
                                tool_name: tool_call.name.clone(),
                                arguments: tool_call.arguments.clone(),
                                reason,
                            });
                            return Ok(message_id);
                        }
                    }
                }
                continue;
            }
        }

        // No tool calls → final response, break
        break;
    }

    let _ = event_tx.send(AgentEvent::TurnComplete {
        conversation_id,
        message_id,
    });

    Ok(message_id)
}

/// Execute a batch of tool calls, emitting events for each.
async fn execute_tool_calls(
    tool_calls: &[ToolCall],
    executor: &ToolExecutor,
    conversation_id: Uuid,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Vec<ExecutionResult> {
    let mut results = Vec::new();

    for tc in tool_calls {
        let result = executor.execute(tc, false).await;

        match &result {
            ExecutionResult::Success(tr) => {
                let _ = event_tx.send(AgentEvent::ToolCallComplete {
                    conversation_id,
                    tool_call_id: tc.id.clone(),
                    tool_name: tc.name.clone(),
                    result: tr.content.clone(),
                    is_error: false,
                });
            }
            ExecutionResult::Error(tr) => {
                let _ = event_tx.send(AgentEvent::ToolCallComplete {
                    conversation_id,
                    tool_call_id: tc.id.clone(),
                    tool_name: tc.name.clone(),
                    result: tr.content.clone(),
                    is_error: true,
                });
            }
            ExecutionResult::NeedsApproval { .. } => {}
        }

        results.push(result);
    }

    results
}
