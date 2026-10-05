//! Core agent loop with bounded channels and lifecycle-aware cancellation.

use std::future::Future;

use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use bc_ai_chat::{ChatManager, ChatMessage, MessageStatus};
use bc_ai_provider::limits::{
    validate_string, MAX_ERROR_BODY_BYTES, MAX_REQUEST_TOOLS, MAX_TOOL_RESULT_BYTES,
    STREAM_CHANNEL_CAPACITY,
};
use bc_ai_provider::*;
use bc_ai_tools::executor::{ExecutionResult, ToolExecutor};
use bc_ai_tools::ToolRegistry;

use crate::config::AgentConfig;
use crate::error::AgentError;
use crate::events::AgentEvent;
use crate::links::{self, LinkStore};
use crate::plan::{self, PlanStore};
use crate::run_summary::RunLedger;

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

/// The assistant's own local tools, as one bundle.
///
/// They are offered and intercepted together because they are the same kind
/// of thing: exact names that are not in the MCP catalogue, hold no MCP
/// permission, and dispatch nothing. They write harness-owned state — a draft
/// plan, one prose field of a run record, a set of validated links — and no
/// more.
fn local_tool_definitions() -> Vec<ToolDefinition> {
    let mut definitions = plan::tool_definitions();
    definitions.extend(links::tool_definitions());
    definitions
}

/// Whether a name is one of those local tools.
///
/// Only the test that pins "everything offered is also intercepted" needs the
/// union. Production code gates each store on its own predicate instead, so a
/// change to what is offered cannot quietly leave one of them interceptable.
#[cfg(test)]
fn is_local_tool(name: &str) -> bool {
    plan::is_plan_tool(name) || links::is_link_tool(name)
}

/// Run one tool call, serving the assistant's own local tools locally and
/// everything else through the permission gate.
///
/// Every call that could actually do something still goes through
/// [`ToolExecutor::execute`], so this is not a second dispatch path. Each
/// store is `None` when its tools were not advertised, in which case those
/// names fall through to the executor, which refuses them as unregistered MCP
/// tools.
///
/// Everything that reaches the executor is recorded in `runs`, opened before
/// the dispatch and closed after it. That is the free-turn half of the run
/// summary: without it a `cf_delete_dns_record` the model calls in an
/// ordinary turn would leave no trace a user could be shown, and silence
/// reads as "nothing happened". The local tools above are deliberately *not*
/// recorded — they are not MCP tools, they dispatch nothing, and they change
/// nothing in the user's account.
async fn execute_one_tool_call(
    tool_call: &ToolCall,
    executor: &ToolExecutor,
    plans: Option<&PlanStore>,
    links: Option<&LinkStore>,
    runs: &RunLedger,
    conversation_id: Uuid,
) -> ExecutionResult {
    if let Some(plans) = plans {
        if let Some(result) =
            plan::try_execute_plan_tool(plans, executor, conversation_id, tool_call).await
        {
            return local_result(result);
        }
    }
    if let Some(links) = links {
        if let Some(result) = links::try_execute_link_tool(links, conversation_id, tool_call).await
        {
            return local_result(result);
        }
    }
    // Opened first, so there is no instant in which a write is in flight and
    // the run summary does not know it; closed with the executor's own
    // verdict, which withdraws the attempt if the gate refused the call.
    let attempt = runs.open_turn_call(conversation_id, &tool_call.name).await;
    let result = executor.execute(tool_call, false).await;
    runs.close_turn_call(conversation_id, attempt, &tool_call.name, &result)
        .await;
    result
}

fn local_result(result: ToolResult) -> ExecutionResult {
    if result.is_error {
        ExecutionResult::Error(result)
    } else {
        ExecutionResult::Success(result)
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_tool_calls(
    tool_calls: &[ToolCall],
    executor: &ToolExecutor,
    plans: Option<&PlanStore>,
    links: Option<&LinkStore>,
    runs: &RunLedger,
    chat: &ChatManager,
    conversation_id: Uuid,
    event_tx: &mpsc::Sender<AgentEvent>,
    cancellation: &mut watch::Receiver<bool>,
    disposal: &mut watch::Receiver<bool>,
) -> Result<bool, AgentError> {
    for tool_call in tool_calls {
        let result = until_lifecycle(
            execute_one_tool_call(tool_call, executor, plans, links, runs, conversation_id),
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
            | ExecutionResult::Denied { result, .. } => {
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

/// Join the configured override onto the prompt already in effect.
///
/// Composition, not substitution: the base prompt is the conversation's own
/// prompt or the selected persona, and replacing either from a global setting
/// would silently discard a choice made elsewhere in the same UI. A per-
/// conversation prompt already *is* the replacement channel — it outranks the
/// persona outright — so this knob only ever adds.
fn compose_system_prompt(base: Option<String>, override_text: Option<&str>) -> Option<String> {
    match (base, override_text) {
        (Some(base), Some(extra)) => Some(format!("{base}\n\n{extra}")),
        (Some(base), None) => Some(base),
        (None, Some(extra)) => Some(extra.to_string()),
        (None, None) => None,
    }
}

/// Trim history to the configured context budget.
///
/// `fit_context_window` keeps the most recent messages, which can leave a
/// tool result at the front with the tool call it answers now dropped. Every
/// protocol rejects that — Anthropic with an unknown `tool_use_id`, OpenAI
/// with a `tool` message that follows no call — so a leading orphan is
/// dropped too. Truncating from the front cannot produce the mirror case: a
/// kept tool call keeps the results that came after it.
fn fit_history(
    messages: Vec<Message>,
    system_prompt: Option<&str>,
    max_context_tokens: u32,
) -> Vec<Message> {
    let fitted = bc_ai_chat::context::fit_context_window(
        &messages,
        system_prompt,
        max_context_tokens as usize,
    );
    // A single message over budget fits nothing. Sending no messages at all is
    // worse than sending one the provider may refuse: it discards what the
    // user just typed and asks the model to answer nothing.
    let mut fitted = if fitted.is_empty() {
        messages.into_iter().next_back().into_iter().collect()
    } else {
        fitted
    };
    let orphans = fitted
        .iter()
        .take_while(|message| {
            matches!(message.content, MessageContent::ToolResult { .. })
                || message.role == Role::Tool
        })
        .count()
        // Never empty the list to remove an orphan: a budget that fits only a
        // tool result is misconfigured, and a request the provider rejects by
        // name beats one with no messages in it at all.
        .min(fitted.len().saturating_sub(1));
    fitted.drain(..orphans);
    fitted
}

/// Run one agentic turn until final text, approval pause, cancellation, or error.
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    provider: &dyn AiProvider,
    chat: &ChatManager,
    registry: &ToolRegistry,
    executor: &ToolExecutor,
    plans: &PlanStore,
    links: &LinkStore,
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
    // The configured override is appended to whichever of the two applies.
    let system_prompt = compose_system_prompt(
        chat.system_prompt(conversation_id).await.or(persona_prompt),
        config.system_prompt_override.as_deref(),
    );
    let model = chat
        .model(conversation_id)
        .await
        .ok_or(bc_ai_chat::ChatError::ConversationNotFound(conversation_id))?;
    // Advertise only the tools that could actually run: granted by the
    // application's MCP permissions and not denied by the assistant's own
    // policy. Offering the rest buys a refused round, and offering an empty
    // list tells the model it has tools when it has none.
    //
    // The assistant's own local tools ride along with them, and only with
    // them: a plan whose steps can call nothing is theatre, and a model
    // offered nothing but `plan_propose` would propose plans it could never
    // carry out. They are appended only while there is room inside
    // `MAX_REQUEST_TOOLS`, so adding them can never make a whole request
    // invalid.
    let tools = if config.tools_enabled {
        let usable = executor
            .usable_definitions(registry.definitions().await)
            .await;
        (!usable.is_empty()).then(|| {
            let mut tools = usable;
            let local = local_tool_definitions();
            if tools.len().saturating_add(local.len()) <= MAX_REQUEST_TOOLS {
                tools.extend(local);
            }
            tools
        })
    } else {
        None
    };
    // A local tool that was not advertised is not intercepted either, so a
    // model that calls one anyway is refused by the gate like any other
    // unregistered name. Each store is gated on its own tools rather than on
    // the bundle, so a future change to what is offered cannot quietly leave
    // one of them interceptable.
    // Taken before `plans` is narrowed to an `Option`: a free-turn call must
    // be recorded whether or not the planning tools were advertised, and the
    // ledger is shared with the plan store so both halves of the account
    // land in one conversation-scoped record.
    let runs = plans.ledger().as_ref();
    let advertised = |predicate: fn(&str) -> bool| {
        tools
            .as_ref()
            .is_some_and(|tools| tools.iter().any(|tool| predicate(&tool.name)))
    };
    let plans = advertised(plan::is_plan_tool).then_some(plans);
    let links = advertised(links::is_link_tool).then_some(links);

    for _round in 0..config.max_tool_rounds {
        let messages = chat
            .provider_messages(conversation_id)
            .await
            .ok_or(bc_ai_chat::ChatError::ConversationNotFound(conversation_id))?;
        // Every configured control is named here. Which of them the selected
        // provider can honour is the client's decision, reported to the
        // renderer through `ai_protocol_capabilities`; a control reaching no
        // provider at all is the bug these fields exist to fix.
        let request = CompletionRequest {
            model: model.clone(),
            messages: fit_history(
                messages,
                system_prompt.as_deref(),
                config.max_context_tokens,
            ),
            system: system_prompt.clone(),
            temperature: Some(config.temperature),
            max_tokens: Some(config.max_tokens_per_turn),
            tools: tools.clone(),
            top_p: Some(config.top_p),
            top_k: config.top_k,
            stop: (!config.stop.is_empty()).then(|| config.stop.clone()),
            seed: config.seed,
            frequency_penalty: config.frequency_penalty,
            presence_penalty: config.presence_penalty,
            timeout_ms: config.request_timeout_ms,
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
                plans,
                links,
                runs,
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
        AiPermissionMode, AiPermissions, AiToolPermission, MCP_GRANT_REFUSAL_MARKER,
        PERMISSION_REFUSAL_PREFIX,
    };
    use bc_mcp::{McpGrantHandle, McpGrantSet};

    use super::*;
    use crate::config::MIN_CONTEXT_TOKENS;
    use crate::run_summary::{AiRunStepTotals, AiRunToolOutcome};

    const READ_TOOL: &str = "dns_parse_spf";
    const WRITE_TOOL: &str = "cf_delete_dns_record";

    /// What is offered and what is intercepted must be the same set. A local
    /// tool advertised but not intercepted would be dispatched to the
    /// executor and refused as an unregistered MCP tool, and the model would
    /// be told its own harness has no such tool.
    #[test]
    fn every_advertised_local_tool_is_also_intercepted() {
        let definitions = local_tool_definitions();
        assert!(!definitions.is_empty());
        for definition in &definitions {
            assert!(
                is_local_tool(&definition.name),
                "{} is advertised but would fall through to the executor",
                definition.name
            );
            assert!(
                bc_mcp::permissions::permission_for_invocation(&definition.name).is_none(),
                "{} is an MCP tool; the local interception would shadow it",
                definition.name
            );
        }
        assert!(!is_local_tool(READ_TOOL));
        assert!(!is_local_tool(WRITE_TOOL));
    }

    /// Asks for the same tool on every round, like a model that will not take
    /// a refusal for an answer.
    struct ToolLoopProvider {
        tool_name: &'static str,
        arguments: serde_json::Value,
        rounds: Arc<AtomicUsize>,
    }

    impl ToolLoopProvider {
        fn new(tool_name: &'static str) -> Self {
            Self::with_arguments(tool_name, serde_json::json!({ "content": "v=spf1 -all" }))
        }

        fn with_arguments(tool_name: &'static str, arguments: serde_json::Value) -> Self {
            Self {
                tool_name,
                arguments,
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
                            arguments: self.arguments.clone(),
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
        plans: PlanStore,
        links: LinkStore,
        conversation_id: Uuid,
    }

    impl Harness {
        /// Grants everything, standing in for a user who enabled every tool in
        /// the MCP tool permissions UI. Tests that need the MCP layer to be the
        /// one refusing pass their own handle to [`Harness::with_grants`].
        async fn new(permissions: AiPermissions) -> Self {
            Self::with_grants(permissions, McpGrantHandle::new(McpGrantSet::all())).await
        }

        async fn with_grants(permissions: AiPermissions, grants: McpGrantHandle) -> Self {
            let chat = ChatManager::default();
            let conversation_id = chat
                .try_create_conversation("ollama".into(), "mock".into(), None, None)
                .await
                .expect("conversation")
                .id;
            chat.try_push_message(conversation_id, ChatMessage::user("do the thing"))
                .await
                .expect("user message");

            let registry = Arc::new(ToolRegistry::default());
            registry.init_all().await;
            let executor = ToolExecutor::with_registry_and_grants(Arc::clone(&registry), grants);
            executor
                .try_set_permissions(permissions)
                .await
                .expect("valid permissions");

            Self {
                chat,
                registry,
                executor,
                plans: PlanStore::default(),
                links: LinkStore::default(),
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
                &self.plans,
                &self.links,
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

    /// The counterpart, and the reason this change exists: a call both layers
    /// permit actually runs, and its real output comes back to the model.
    #[tokio::test]
    async fn a_permitted_tool_call_executes_and_returns_its_output() {
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
        let (content, is_error) = harness
            .tool_results()
            .await
            .pop()
            .expect("the call produced a result");
        assert!(
            !content.starts_with(PERMISSION_REFUSAL_PREFIX),
            "a permitted read tool must not be refused: {content}"
        );
        assert!(!is_error, "the tool really ran: {content}");
        assert!(
            content.contains("v=spf1"),
            "the parsed SPF record must come back to the model: {content}"
        );
    }

    /// A tool the application's MCP permissions do not grant is refused the
    /// same way: fed back to the model, counted against the round limit, and
    /// named as the application's grants rather than the assistant's policy.
    #[tokio::test]
    async fn an_ungranted_tool_is_refused_by_the_mcp_layer_and_consumes_rounds() {
        let harness = Harness::with_grants(
            AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::from([(READ_TOOL.to_string(), AiToolPermission::Allow)]),
            },
            McpGrantHandle::default(),
        )
        .await;
        let provider = ToolLoopProvider::new(READ_TOOL);
        let rounds = 2;

        let error = harness
            .run(&provider, &config(rounds), None)
            .await
            .expect_err("a model calling an ungranted tool must hit the round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(limit) if limit == rounds));

        let results = harness.tool_results().await;
        assert_eq!(results.len(), rounds as usize);
        for (content, is_error) in results {
            assert!(content.starts_with(PERMISSION_REFUSAL_PREFIX));
            assert!(
                content.contains(MCP_GRANT_REFUSAL_MARKER),
                "the user must be told which permission list refused: {content}"
            );
            assert!(is_error);
        }
    }

    /// With nothing granted there is nothing to advertise, so the model is
    /// offered no tools at all rather than a list it cannot use.
    #[tokio::test]
    async fn no_granted_tools_means_no_tool_list_is_sent_to_the_provider() {
        let ungranted =
            Harness::with_grants(AiPermissions::default(), McpGrantHandle::default()).await;
        let provider = CapturingProvider::default();
        ungranted
            .run(&provider, &config(2), None)
            .await
            .expect("plain text turn completes");
        assert!(
            provider
                .request
                .lock()
                .expect("request")
                .as_ref()
                .expect("the provider was called")
                .tools
                .is_none(),
            "an empty tool list must not be advertised as tool support"
        );

        let granted = Harness::new(AiPermissions::default()).await;
        let provider = CapturingProvider::default();
        granted
            .run(&provider, &config(2), None)
            .await
            .expect("plain text turn completes");
        let advertised = provider
            .request
            .lock()
            .expect("request")
            .as_ref()
            .expect("the provider was called")
            .tools
            .clone()
            .expect("granted tools are advertised");
        assert!(advertised.iter().any(|tool| tool.name == READ_TOOL));
    }

    /// The planning tools are offered alongside the granted tools, and only
    /// alongside them: a model offered nothing but `plan_propose` would plan
    /// work it could never carry out, and advertising two tools where there
    /// were none would tell a zero-grant install it has tool support.
    #[tokio::test]
    async fn the_planning_tools_are_advertised_with_the_granted_tools_and_not_without_them() {
        let granted = Harness::new(AiPermissions::default()).await;
        let provider = CapturingProvider::default();
        granted
            .run(&provider, &config(2), None)
            .await
            .expect("turn completes");
        let advertised = provider
            .request
            .lock()
            .expect("request")
            .as_ref()
            .expect("the provider was called")
            .tools
            .clone()
            .expect("granted tools are advertised");
        for name in [plan::PLAN_PROPOSE_TOOL, plan::PLAN_REVISE_TOOL] {
            assert!(
                advertised.iter().any(|tool| tool.name == name),
                "{name} must be offered when the assistant has tools at all"
            );
        }
        assert!(advertised.len() <= MAX_REQUEST_TOOLS);

        let ungranted =
            Harness::with_grants(AiPermissions::default(), McpGrantHandle::default()).await;
        let provider = CapturingProvider::default();
        ungranted
            .run(&provider, &config(2), None)
            .await
            .expect("turn completes");
        assert!(
            provider
                .request
                .lock()
                .expect("request")
                .as_ref()
                .expect("the provider was called")
                .tools
                .is_none(),
            "planning must not turn a zero-grant install into one that advertises tools"
        );
    }

    /// A model proposing a plan gets a draft and nothing else: no dispatch,
    /// no approval, no step run. This is the only effect either planning tool
    /// can have.
    /// MUTATION PROOF: a mutating tool the model calls in an ordinary turn —
    /// no plan anywhere — must reach `mutatingToolsRun`.
    ///
    /// Drop the `open_turn_call`/`close_turn_call` pair from
    /// `execute_one_tool_call` and this fails: the summary goes silent about
    /// a write, and silence is what a user reads as "nothing happened".
    #[tokio::test]
    async fn a_free_turn_mutating_call_is_accounted_for_without_any_plan() {
        let harness = Harness::new(AiPermissions {
            mode: AiPermissionMode::Autonomous,
            tools: BTreeMap::new(),
        })
        .await;
        let provider = ToolLoopProvider::with_arguments(
            WRITE_TOOL,
            serde_json::json!({ "confirmHighRisk": true }),
        );

        let error = harness
            .run(&provider, &config(1), None)
            .await
            .expect_err("round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(1)));

        // No plan was ever proposed, let alone approved.
        assert!(harness.plans.get(harness.conversation_id).await.is_none());

        let summary = harness
            .plans
            .ledger()
            .summary(harness.conversation_id)
            .await
            .expect("a free-turn call is still accounted for");
        assert!(
            summary.plan_id.is_none(),
            "there is no plan, so the summary must not name one"
        );
        assert!(summary.title.is_none());
        assert_eq!(summary.step_totals, AiRunStepTotals::default());
        assert_eq!(
            summary.mutating_tools_run,
            vec![WRITE_TOOL.to_string()],
            "a write the model ran in an ordinary turn must be named"
        );
        assert!(
            summary.any_change_attempted,
            "the user asking what changed must not be told nothing did"
        );

        // It is one call, recorded with no step index rather than a fake one.
        assert_eq!(summary.tool_runs.len(), 1);
        assert_eq!(summary.tool_runs[0].tool, WRITE_TOOL);
        assert!(summary.tool_runs[0].step_index.is_none());
    }

    /// A read the model runs in an ordinary turn is recorded, and is not a
    /// change. The two halves of that matter equally: over-reporting a read
    /// as a write would make the field useless by crying wolf.
    #[tokio::test]
    async fn a_free_turn_read_is_recorded_without_claiming_a_change() {
        let harness = Harness::new(AiPermissions::default()).await;
        let provider = ToolLoopProvider::new(READ_TOOL);

        let error = harness
            .run(&provider, &config(1), None)
            .await
            .expect_err("round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(1)));

        let summary = harness
            .plans
            .ledger()
            .summary(harness.conversation_id)
            .await
            .expect("a summary");
        assert_eq!(summary.tool_runs.len(), 1);
        assert_eq!(summary.tool_runs[0].tool, READ_TOOL);
        assert_eq!(summary.tool_runs[0].outcome, AiRunToolOutcome::Ok);
        assert!(summary.mutating_tools_run.is_empty());
        assert!(!summary.any_change_attempted);
        assert!(
            summary.finished_at.is_some(),
            "nothing is outstanding once the call has returned"
        );
    }

    /// A refused write dispatched nothing, so it must not be reported as a
    /// change — even though the model asked for it.
    #[tokio::test]
    async fn a_free_turn_write_the_policy_refuses_is_not_a_change() {
        let harness = Harness::new(AiPermissions {
            mode: AiPermissionMode::ReadOnly,
            tools: BTreeMap::new(),
        })
        .await;
        let provider = ToolLoopProvider::with_arguments(
            WRITE_TOOL,
            serde_json::json!({ "confirmHighRisk": true }),
        );

        let error = harness
            .run(&provider, &config(1), None)
            .await
            .expect_err("round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(1)));

        let summary = harness
            .plans
            .ledger()
            .summary(harness.conversation_id)
            .await
            .expect("a summary");
        assert_eq!(summary.tool_runs[0].outcome, AiRunToolOutcome::Denied);
        assert!(
            summary.mutating_tools_run.is_empty(),
            "a refused call never left the harness"
        );
        assert!(!summary.any_change_attempted);
        assert_eq!(summary.refusals.len(), 1);
        assert_eq!(summary.refusals[0].tool, WRITE_TOOL);
    }

    /// The assistant's own local tools change nothing in the user's account,
    /// so they must not appear in the account of what ran.
    #[tokio::test]
    async fn a_local_tool_is_not_recorded_as_a_tool_run() {
        let harness = Harness::new(AiPermissions::default()).await;
        let provider = ToolLoopProvider::with_arguments(
            links::LINK_OFFER_TOOL,
            serde_json::json!({
                "links": [{ "kind": "workspace", "label": "Audit", "target": "audit" }]
            }),
        );

        let error = harness
            .run(&provider, &config(1), None)
            .await
            .expect_err("round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(1)));
        assert_eq!(harness.links.get(harness.conversation_id).await.len(), 1);
        assert!(
            harness
                .plans
                .ledger()
                .summary(harness.conversation_id)
                .await
                .is_none(),
            "offering a link dispatches nothing, so there is nothing to account for"
        );
    }

    #[tokio::test]
    async fn a_model_proposing_a_plan_gets_a_draft_and_runs_nothing() {
        let harness = Harness::new(AiPermissions {
            mode: AiPermissionMode::ReadOnly,
            tools: BTreeMap::new(),
        })
        .await;
        let provider = ToolLoopProvider::with_arguments(
            plan::PLAN_PROPOSE_TOOL,
            serde_json::json!({
                "title": "Tidy the zone",
                "steps": [
                    { "title": "parse it", "tool": READ_TOOL, "arguments": { "content": "v=spf1 -all" } },
                    { "title": "delete it", "tool": WRITE_TOOL },
                ],
            }),
        );

        let error = harness
            .run(&provider, &config(1), None)
            .await
            .expect_err("round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(1)));

        let (content, is_error) = harness
            .tool_results()
            .await
            .pop()
            .expect("the plan tool answered");
        assert!(!is_error, "{content}");
        assert!(
            !content.starts_with(PERMISSION_REFUSAL_PREFIX),
            "a planning tool is served locally, not refused by the MCP layer: {content}"
        );
        // The model is told which step cannot run, so it can revise or explain.
        assert!(content.contains("blockedSteps"), "{content}");
        assert!(
            content.contains("mcpGrants") || content.contains("assistantPolicy"),
            "{content}"
        );

        let plan = harness
            .plans
            .get(harness.conversation_id)
            .await
            .expect("a draft was recorded");
        assert_eq!(plan.status, plan::AiPlanStatus::Draft);
        assert_eq!(plan.steps[0].status, plan::AiPlanStepStatus::Pending);
        assert_eq!(
            plan.steps[1].status,
            plan::AiPlanStepStatus::Blocked,
            "read-only mode blocks the write step at plan time"
        );
        assert!(
            plan.steps.iter().all(|step| step.result.is_none()),
            "proposing a plan must execute nothing"
        );
    }

    /// With nothing granted the planning tools are not advertised, so a model
    /// that calls one anyway is refused by the gate like any other name the
    /// MCP catalogue does not define. There is no unadvertised back door.
    #[tokio::test]
    async fn a_plan_tool_call_is_refused_when_planning_was_not_advertised() {
        let harness =
            Harness::with_grants(AiPermissions::default(), McpGrantHandle::default()).await;
        let provider = ToolLoopProvider::with_arguments(
            plan::PLAN_PROPOSE_TOOL,
            serde_json::json!({
                "title": "Tidy the zone",
                "steps": [{ "title": "parse it" }],
            }),
        );

        let error = harness
            .run(&provider, &config(1), None)
            .await
            .expect_err("round limit");
        assert!(matches!(error, AgentError::ToolRoundLimit(1)));
        let (content, is_error) = harness
            .tool_results()
            .await
            .pop()
            .expect("a refusal was recorded");
        assert!(is_error);
        assert!(content.starts_with(PERMISSION_REFUSAL_PREFIX), "{content}");
        assert!(content.contains(MCP_GRANT_REFUSAL_MARKER), "{content}");
        assert!(
            harness.plans.get(harness.conversation_id).await.is_none(),
            "a refused planning call must record no plan"
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
                "ollama".into(),
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
            &harness.plans,
            &harness.links,
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

    /// The defect these fields exist to fix: `top_p` was stored, validated,
    /// migrated and unit-tested while appearing nowhere in any request. A
    /// control that validates but does nothing is worse than an absent one,
    /// because the user believes it — so every one of them is pinned here on
    /// the hop from configuration to request.
    ///
    /// Which controls the *selected provider* then honours is a separate
    /// contract, pinned by `sampling::tests` against each client's real body.
    #[tokio::test]
    async fn the_configured_sampling_knobs_reach_the_provider() {
        let harness = Harness::new(AiPermissions::default()).await;
        let provider = CapturingProvider::default();
        let configured = AgentConfig {
            temperature: 0.3,
            top_p: 0.85,
            top_k: Some(40),
            stop: vec!["\nUser:".into()],
            seed: Some(1234),
            frequency_penalty: Some(0.5),
            presence_penalty: Some(-0.25),
            request_timeout_ms: Some(45_000),
            ..config(2)
        };

        harness
            .run(&provider, &configured, None)
            .await
            .expect("plain text turn completes");

        let request = provider
            .request
            .lock()
            .expect("request")
            .clone()
            .expect("the provider was called");
        assert_eq!(request.temperature, Some(0.3));
        assert_eq!(request.top_p, Some(0.85));
        assert_eq!(request.top_k, Some(40));
        assert_eq!(request.stop, Some(vec!["\nUser:".to_string()]));
        assert_eq!(request.seed, Some(1234));
        assert_eq!(request.frequency_penalty, Some(0.5));
        assert_eq!(request.presence_penalty, Some(-0.25));
        assert_eq!(request.timeout_ms, Some(45_000));
        assert_eq!(request.max_tokens, Some(configured.max_tokens_per_turn));
    }

    /// An unconfigured control is absent rather than sent as a default, so
    /// upgrading cannot change how an existing install generates.
    #[tokio::test]
    async fn unconfigured_knobs_are_absent_from_the_request() {
        let harness = Harness::new(AiPermissions::default()).await;
        let provider = CapturingProvider::default();

        harness
            .run(&provider, &config(2), None)
            .await
            .expect("turn completes");

        let request = provider
            .request
            .lock()
            .expect("request")
            .clone()
            .expect("the provider was called");
        assert_eq!(request.top_k, None);
        assert_eq!(request.stop, None, "an empty stop list is not a setting");
        assert_eq!(request.seed, None);
        assert_eq!(request.frequency_penalty, None);
        assert_eq!(request.presence_penalty, None);
        assert_eq!(request.timeout_ms, None);
        // `top_p` is not optional in the configuration — it has always had a
        // stored default — so it is always sent, exactly like temperature.
        assert_eq!(request.top_p, Some(AgentConfig::default().top_p));
    }

    /// The override composes with the persona rather than replacing it: the
    /// persona is a separate choice in the same settings panel, and a true
    /// replacement already exists per conversation.
    #[tokio::test]
    async fn the_system_prompt_override_is_appended_to_the_prompt_in_effect() {
        let harness = Harness::new(AiPermissions::default()).await;
        let provider = CapturingProvider::default();
        let configured = AgentConfig {
            system_prompt_override: Some("Prefer UK English.".into()),
            ..config(2)
        };

        harness
            .run(&provider, &configured, Some("You are the persona.".into()))
            .await
            .expect("turn completes");

        let request = provider
            .request
            .lock()
            .expect("request")
            .clone()
            .expect("the provider was called");
        assert_eq!(
            request.system.as_deref(),
            Some("You are the persona.\n\nPrefer UK English.")
        );
    }

    #[tokio::test]
    async fn the_override_applies_with_no_persona_prompt_at_all() {
        let harness = Harness::new(AiPermissions::default()).await;
        let provider = CapturingProvider::default();
        let configured = AgentConfig {
            system_prompt_override: Some("Prefer UK English.".into()),
            ..config(2)
        };

        harness
            .run(&provider, &configured, None)
            .await
            .expect("turn completes");

        let request = provider
            .request
            .lock()
            .expect("request")
            .clone()
            .expect("the provider was called");
        assert_eq!(request.system.as_deref(), Some("Prefer UK English."));
    }

    /// `max_context_tokens` has to actually bound what is sent — before this
    /// change `fit_context_window` was called from nowhere but its own tests,
    /// so a long conversation went to the provider whole.
    #[tokio::test]
    async fn the_context_budget_bounds_the_history_that_is_sent() {
        let harness = Harness::new(AiPermissions::default()).await;
        for index in 0..8 {
            harness
                .chat
                .try_push_message(
                    harness.conversation_id,
                    ChatMessage::user(format!("message {index} {}", "padding ".repeat(64))),
                )
                .await
                .expect("user message");
        }
        let provider = CapturingProvider::default();
        let configured = AgentConfig {
            max_context_tokens: MIN_CONTEXT_TOKENS,
            ..config(2)
        };

        harness
            .run(&provider, &configured, None)
            .await
            .expect("turn completes");

        let request = provider
            .request
            .lock()
            .expect("request")
            .clone()
            .expect("the provider was called");
        let sent = request.messages.len();
        assert!(sent > 0, "a budget must never send an empty history");
        assert!(
            sent < 9,
            "the budget did not bound the history: {sent} sent"
        );
        // What survives is the tail, so the newest turn is what the model sees.
        assert!(
            request.messages[sent - 1].content.as_text().contains("7"),
            "the most recent message was dropped"
        );
    }

    /// Truncation must not hand a provider a tool result whose call it can no
    /// longer see: Anthropic rejects the unknown `tool_use_id` and OpenAI the
    /// `tool` message that follows no call.
    #[test]
    fn fitting_never_leaves_a_tool_result_without_its_call() {
        let messages = vec![
            Message::tool_result("call-1", "{}", false),
            Message::tool_result("call-2", "{}", false),
            Message::assistant("here is the answer"),
        ];
        // A budget small enough to drop the assistant turn that made the call.
        let fitted = fit_history(messages.clone(), None, MIN_CONTEXT_TOKENS);
        assert!(
            !matches!(fitted[0].content, MessageContent::ToolResult { .. }),
            "a leading orphaned tool result survived: {:?}",
            fitted[0].content
        );

        // And a budget that fits nothing still sends the newest message.
        let fitted = fit_history(messages, None, MIN_CONTEXT_TOKENS);
        assert_eq!(fitted.len(), 1);
        assert_eq!(fitted[0].content.as_text(), "here is the answer");
    }

    #[test]
    fn composition_covers_every_combination_of_base_and_override() {
        assert_eq!(
            compose_system_prompt(Some("base".into()), Some("extra")).as_deref(),
            Some("base\n\nextra")
        );
        assert_eq!(
            compose_system_prompt(Some("base".into()), None).as_deref(),
            Some("base")
        );
        assert_eq!(
            compose_system_prompt(None, Some("extra")).as_deref(),
            Some("extra")
        );
        assert_eq!(compose_system_prompt(None, None), None);
    }
}
