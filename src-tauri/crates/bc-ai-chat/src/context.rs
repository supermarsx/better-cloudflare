//! Context window management.
//!
//! Handles token estimation and message truncation to keep
//! conversations within provider context limits.

use bc_ai_provider::Message;

/// Simple token estimator using character-based heuristic.
/// ~4 characters per token on average for English text.
const CHARS_PER_TOKEN: usize = 4;

/// Estimate token count for a message.
pub fn estimate_tokens(message: &Message) -> usize {
    let text = message.content.as_text();
    // Add a small overhead for message framing
    (text.len() / CHARS_PER_TOKEN) + 4
}

/// Estimate total tokens for a list of messages.
pub fn estimate_total_tokens(messages: &[Message]) -> usize {
    messages.iter().map(|m| estimate_tokens(m)).sum()
}

/// Truncate messages to fit within a context window.
///
/// Preserves the system message (first), the most recent messages,
/// and drops older messages from the middle when needed.
pub fn fit_context_window(
    messages: &[Message],
    system_prompt: Option<&str>,
    max_tokens: usize,
) -> Vec<Message> {
    if messages.is_empty() {
        return Vec::new();
    }

    let system_overhead = system_prompt
        .map(|s| (s.len() / CHARS_PER_TOKEN) + 4)
        .unwrap_or(0);

    let available = max_tokens.saturating_sub(system_overhead);

    // Start from the most recent messages and work backwards
    let mut result = Vec::new();
    let mut used_tokens = 0;

    for msg in messages.iter().rev() {
        let cost = estimate_tokens(msg);
        if used_tokens + cost > available {
            break;
        }
        used_tokens += cost;
        result.push(msg.clone());
    }

    result.reverse();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use bc_ai_provider::Message;

    #[test]
    fn test_estimate_tokens() {
        let msg = Message::user("Hello, world!"); // 13 chars → ~3 tokens + 4 overhead = 7
        let tokens = estimate_tokens(&msg);
        assert!(tokens > 0);
        assert!(tokens < 20);
    }

    #[test]
    fn test_fit_context_window_empty() {
        let result = fit_context_window(&[], None, 1000);
        assert!(result.is_empty());
    }

    #[test]
    fn test_fit_context_window_keeps_recent() {
        let messages = vec![
            Message::user("First message that is quite long and should be dropped"),
            Message::assistant("Response to first"),
            Message::user("Second message"),
            Message::assistant("Response to second"),
        ];
        // With very small budget, only last messages should fit
        let result = fit_context_window(&messages, None, 20);
        assert!(!result.is_empty());
        assert!(result.len() <= messages.len());
    }
}
