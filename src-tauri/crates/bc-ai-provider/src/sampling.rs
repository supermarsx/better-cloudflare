//! Advanced generation controls, and which protocol honours each one.
//!
//! A knob a provider cannot take must be *reported* as inapplicable, never
//! silently dropped — `top_p` was stored, validated and migrated for a release
//! while reaching no provider at all, and six more knobs behaving that way
//! would multiply the same lie.
//!
//! So there is exactly one table per protocol, pairing the control with the
//! wire key that protocol takes it under. The clients build their request
//! bodies by walking that table, and [`protocol_capabilities`] reports the same
//! table to the renderer. A control absent from a table therefore cannot reach
//! that protocol's body, and one present in it cannot be missing from the body
//! — there is no second list to drift from.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::ProviderProtocol;
use crate::types::CompletionRequest;

/// One advanced generation control a [`CompletionRequest`] may carry.
///
/// Serialises in camelCase, because the renderer reads these names straight
/// out of [`protocol_capabilities`] to decide which inputs to disable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdvancedField {
    TopP,
    TopK,
    Stop,
    Seed,
    FrequencyPenalty,
    PresencePenalty,
}

impl AdvancedField {
    /// Every control, in the order the capability list reports them.
    pub const ALL: &'static [Self] = &[
        Self::TopP,
        Self::TopK,
        Self::Stop,
        Self::Seed,
        Self::FrequencyPenalty,
        Self::PresencePenalty,
    ];

    /// The camelCase name this control is reported under.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TopP => "topP",
            Self::TopK => "topK",
            Self::Stop => "stop",
            Self::Seed => "seed",
            Self::FrequencyPenalty => "frequencyPenalty",
            Self::PresencePenalty => "presencePenalty",
        }
    }

    /// This control's value on `request`, or `None` when it is unset — an
    /// unset control is not sent even to a protocol that honours it.
    fn value(&self, request: &CompletionRequest) -> Option<Value> {
        match self {
            Self::TopP => request.top_p.map(|value| json!(value)),
            Self::TopK => request.top_k.map(|value| json!(value)),
            // An empty list is not a request to stop on nothing; it is the
            // absence of a setting, and OpenAI rejects an empty `stop` array.
            Self::Stop => request
                .stop
                .as_ref()
                .filter(|stop| !stop.is_empty())
                .map(|stop| json!(stop)),
            Self::Seed => request.seed.map(|value| json!(value)),
            Self::FrequencyPenalty => request.frequency_penalty.map(|value| json!(value)),
            Self::PresencePenalty => request.presence_penalty.map(|value| json!(value)),
        }
    }
}

/// Controls and their wire keys for the OpenAI chat-completions body.
const OPENAI: &[(AdvancedField, &str)] = &[
    (AdvancedField::TopP, "top_p"),
    (AdvancedField::Stop, "stop"),
    (AdvancedField::Seed, "seed"),
    (AdvancedField::FrequencyPenalty, "frequency_penalty"),
    (AdvancedField::PresencePenalty, "presence_penalty"),
];

/// Controls and their wire keys for the Anthropic messages body.
///
/// `seed` and both penalties are absent because the Messages API has no
/// equivalent field; sending one is a 400, not a no-op.
const ANTHROPIC: &[(AdvancedField, &str)] = &[
    (AdvancedField::TopP, "top_p"),
    (AdvancedField::TopK, "top_k"),
    (AdvancedField::Stop, "stop_sequences"),
];

/// Controls and their wire keys inside Ollama's `options` object.
///
/// `frequency_penalty` is deliberately *not* mapped onto `repeat_penalty`.
/// They are not the same control: `frequency_penalty` is additive over −2…2
/// with 0 meaning "no penalty", while `repeat_penalty` is a multiplicative
/// divisor on repeated-token logits with 1.0 meaning "no penalty". Forwarding
/// one as the other would turn a user's harmless 0.0 into a value that zeroes
/// out every repeated token, so Ollama reports it as unsupported instead.
/// `presence_penalty` has no native `options` equivalent either.
const OLLAMA: &[(AdvancedField, &str)] = &[
    (AdvancedField::TopP, "top_p"),
    (AdvancedField::TopK, "top_k"),
    (AdvancedField::Stop, "stop"),
    (AdvancedField::Seed, "seed"),
];

fn table(protocol: ProviderProtocol) -> &'static [(AdvancedField, &'static str)] {
    match protocol {
        ProviderProtocol::OpenAi => OPENAI,
        ProviderProtocol::Anthropic => ANTHROPIC,
        ProviderProtocol::Ollama => OLLAMA,
    }
}

/// The advanced controls one protocol honours.
pub fn honoured_fields(protocol: ProviderProtocol) -> Vec<AdvancedField> {
    table(protocol).iter().map(|(field, _)| *field).collect()
}

/// Whether one protocol honours one control.
pub fn honours(protocol: ProviderProtocol, field: AdvancedField) -> bool {
    table(protocol)
        .iter()
        .any(|(candidate, _)| *candidate == field)
}

/// Every protocol's honoured controls, keyed by the protocol's wire spelling.
///
/// This is what `ai_protocol_capabilities` returns, so the renderer can mark a
/// configured-but-inapplicable setting as inapplicable instead of guessing.
pub fn protocol_capabilities() -> BTreeMap<&'static str, Vec<AdvancedField>> {
    ProviderProtocol::ALL
        .iter()
        .map(|protocol| (protocol.as_str(), honoured_fields(*protocol)))
        .collect()
}

/// The `(wire key, value)` pairs one protocol actually sends for `request`.
///
/// Walks that protocol's table, so a control it does not honour is omitted and
/// a control it does honour is present whenever the request carries a value.
pub(crate) fn advanced_entries(
    protocol: ProviderProtocol,
    request: &CompletionRequest,
) -> Vec<(&'static str, Value)> {
    table(protocol)
        .iter()
        .filter_map(|(field, key)| field.value(request).map(|value| (*key, value)))
        .collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::types::Message;

    /// A request carrying every advanced control, so a client's body can be
    /// checked for exactly the controls its protocol claims.
    pub(crate) fn request_with_every_control() -> CompletionRequest {
        CompletionRequest {
            model: "test-model".into(),
            messages: vec![Message::user("hello")],
            tools: None,
            temperature: Some(0.7),
            max_tokens: Some(256),
            system: None,
            top_p: Some(0.9),
            top_k: Some(40),
            stop: Some(vec!["\nUser:".into()]),
            seed: Some(42),
            frequency_penalty: Some(0.5),
            presence_penalty: Some(0.25),
            timeout_ms: Some(30_000),
        }
    }

    /// Every wire spelling a control is known by across the three protocols.
    ///
    /// A client that "supports" an unhonoured knob by quietly renaming it —
    /// `frequency_penalty` as Ollama's `repeat_penalty`, say — would satisfy a
    /// test that only looked for the one spelling, so the negative half of the
    /// drift test looks for all of them.
    pub(crate) fn known_wire_keys(field: AdvancedField) -> &'static [&'static str] {
        match field {
            AdvancedField::TopP => &["top_p", "topP"],
            AdvancedField::TopK => &["top_k", "topK"],
            AdvancedField::Stop => &["stop", "stop_sequences", "stopSequences"],
            AdvancedField::Seed => &["seed"],
            AdvancedField::FrequencyPenalty => &["frequency_penalty", "repeat_penalty"],
            AdvancedField::PresencePenalty => &["presence_penalty"],
        }
    }

    /// Collect every key appearing anywhere in a request body, so placement
    /// (top level for OpenAI and Anthropic, nested under `options` for Ollama)
    /// is not restated by the test.
    pub(crate) fn keys_anywhere(body: &Value) -> Vec<String> {
        let mut keys = Vec::new();
        collect(body, &mut keys);
        keys
    }

    fn collect(value: &Value, keys: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, nested) in map {
                    keys.push(key.clone());
                    collect(nested, keys);
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect(item, keys);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::config::ProviderConfig;

    /// The names the renderer switches on, pinned so a rename here cannot
    /// silently stop disabling an inapplicable input.
    #[test]
    fn capability_names_are_camel_case_on_the_wire() {
        for field in AdvancedField::ALL {
            assert_eq!(
                serde_json::to_value(field).expect("serializes"),
                json!(field.as_str()),
                "{field:?} reports a name its wire form does not match"
            );
            assert!(
                !field.as_str().contains('_'),
                "{field:?} leaked snake_case: {}",
                field.as_str()
            );
        }
    }

    #[test]
    fn the_capability_list_is_keyed_by_the_protocol_wire_spelling() {
        let capabilities = protocol_capabilities();
        // A `BTreeMap` so the object is stable rather than hash-ordered; the
        // renderer looks keys up by protocol, so sorted order is the contract.
        assert_eq!(
            capabilities.keys().copied().collect::<Vec<_>>(),
            vec!["anthropic", "ollama", "openai"]
        );
        // The exact payload `ai_protocol_capabilities` returns.
        let value = serde_json::to_value(&capabilities).expect("serializes");
        assert_eq!(
            value["openai"],
            json!([
                "topP",
                "stop",
                "seed",
                "frequencyPenalty",
                "presencePenalty"
            ])
        );
        assert_eq!(value["anthropic"], json!(["topP", "topK", "stop"]));
        assert_eq!(value["ollama"], json!(["topP", "topK", "stop", "seed"]));
    }

    /// An unhonoured control is omitted even when the request carries it, and
    /// an honoured one is present — both read off the same table, so this is
    /// about the *table*; the per-client drift test proves the bodies match.
    #[test]
    fn entries_cover_exactly_the_honoured_controls() {
        let request = request_with_every_control();
        for protocol in ProviderProtocol::ALL {
            let entries = advanced_entries(*protocol, &request);
            assert_eq!(
                entries.len(),
                honoured_fields(*protocol).len(),
                "{protocol} sent a different number of controls than it claims"
            );
            for field in AdvancedField::ALL {
                let claimed = honours(*protocol, *field);
                let table_key = table(*protocol)
                    .iter()
                    .find(|(candidate, _)| candidate == field)
                    .map(|(_, key)| *key);
                assert_eq!(
                    claimed,
                    table_key.is_some(),
                    "{protocol} disagrees with itself about {field:?}"
                );
                if let Some(key) = table_key {
                    assert!(
                        entries.iter().any(|(sent, _)| *sent == key),
                        "{protocol} claims {field:?} but sends no {key}"
                    );
                }
            }
        }
    }

    /// An unset control is absent even from a protocol that honours it, so
    /// "not configured" never becomes an explicit null on the wire.
    #[test]
    fn unset_controls_are_not_sent_at_all() {
        let mut request = request_with_every_control();
        request.top_p = None;
        request.top_k = None;
        request.stop = None;
        request.seed = None;
        request.frequency_penalty = None;
        request.presence_penalty = None;

        for protocol in ProviderProtocol::ALL {
            assert!(
                advanced_entries(*protocol, &request).is_empty(),
                "{protocol} sent a control that was never configured"
            );
        }
    }

    /// An empty `stop` list is the absence of a setting, not a request to send
    /// `"stop": []` — which OpenAI rejects.
    #[test]
    fn an_empty_stop_list_is_not_sent() {
        let mut request = request_with_every_control();
        request.stop = Some(Vec::new());
        for protocol in ProviderProtocol::ALL {
            assert!(
                !advanced_entries(*protocol, &request)
                    .iter()
                    .any(|(key, _)| known_wire_keys(AdvancedField::Stop).contains(key)),
                "{protocol} sent an empty stop list"
            );
        }
    }

    fn body_for(protocol: ProviderProtocol, request: &CompletionRequest) -> Value {
        let config = ProviderConfig {
            protocol,
            api_key: Some("test-key".into()),
            base_url: None,
            model: "test-model".into(),
            temperature: 0.7,
            max_tokens: 1024,
        };
        match protocol {
            ProviderProtocol::OpenAi => crate::openai::OpenAiProvider::build_body(request, false),
            ProviderProtocol::Anthropic => crate::anthropic::AnthropicProvider::new(config)
                .expect("client")
                .build_body(request),
            ProviderProtocol::Ollama => json!({
                "options": crate::ollama::OllamaProvider::build_options(request),
            }),
        }
    }

    /// The test the capability list exists for.
    ///
    /// For every protocol and every control: a claimed control appears in that
    /// client's real request body under the claimed wire key, and an unclaimed
    /// one appears nowhere in the body under *any* spelling the knob is known
    /// by. The second half is what stops a client from "supporting" a knob by
    /// quietly renaming it onto a field that means something else.
    #[test]
    fn each_client_sends_exactly_what_the_capability_list_claims() {
        let request = request_with_every_control();
        for protocol in ProviderProtocol::ALL {
            let body = body_for(*protocol, &request);
            let keys = keys_anywhere(&body);

            for field in AdvancedField::ALL {
                if honours(*protocol, *field) {
                    let (_, key) = table(*protocol)
                        .iter()
                        .find(|(candidate, _)| candidate == field)
                        .copied()
                        .expect("an honoured control has a wire key");
                    assert!(
                        keys.iter().any(|present| present == key),
                        "{protocol} claims {} but its body has no {key}: {body}",
                        field.as_str()
                    );
                    continue;
                }
                for spelling in known_wire_keys(*field) {
                    assert!(
                        !keys.iter().any(|present| present == spelling),
                        "{protocol} does not claim {} yet its body carries {spelling}: {body}",
                        field.as_str()
                    );
                }
            }
        }
    }

    /// Placement is part of the contract too: Ollama takes its controls inside
    /// `options`, and a value that landed at the top level would be ignored by
    /// the server while every key-presence assertion still passed.
    #[test]
    fn each_client_sends_the_configured_values_where_the_protocol_reads_them() {
        let request = request_with_every_control();

        let openai = body_for(ProviderProtocol::OpenAi, &request);
        assert_eq!(openai["top_p"], json!(0.9f32));
        assert_eq!(openai["stop"], json!(["\nUser:"]));
        assert_eq!(openai["seed"], json!(42));
        assert_eq!(openai["frequency_penalty"], json!(0.5f32));
        assert_eq!(openai["presence_penalty"], json!(0.25f32));

        let anthropic = body_for(ProviderProtocol::Anthropic, &request);
        assert_eq!(anthropic["top_p"], json!(0.9f32));
        assert_eq!(anthropic["top_k"], json!(40));
        assert_eq!(anthropic["stop_sequences"], json!(["\nUser:"]));

        let ollama = body_for(ProviderProtocol::Ollama, &request);
        assert_eq!(ollama["options"]["top_p"], json!(0.9f32));
        assert_eq!(ollama["options"]["top_k"], json!(40));
        assert_eq!(ollama["options"]["stop"], json!(["\nUser:"]));
        assert_eq!(ollama["options"]["seed"], json!(42));
        // Temperature already worked; it must keep working now that it shares
        // the options object with the new controls.
        assert_eq!(ollama["options"]["temperature"], json!(0.7f32));
    }

    /// Streaming and one-shot are the same body plus a flag. A control that
    /// reached only one of them would be honoured or dropped depending on a
    /// setting the user set somewhere else entirely.
    #[test]
    fn streaming_sends_the_same_controls_as_a_one_shot_completion() {
        let request = request_with_every_control();
        let mut streamed = crate::openai::OpenAiProvider::build_body(&request, true);
        assert_eq!(streamed["stream"], json!(true));
        let one_shot = crate::openai::OpenAiProvider::build_body(&request, false);
        assert!(one_shot.get("stream").is_none());

        streamed
            .as_object_mut()
            .expect("object")
            .remove("stream")
            .expect("the flag under test");
        assert_eq!(streamed, one_shot);
    }

    #[test]
    fn body_key_collection_finds_nested_option_keys() {
        let body = json!({"model": "m", "options": {"top_k": 40}, "messages": [{"role": "user"}]});
        let keys = keys_anywhere(&body);
        for expected in ["model", "options", "top_k", "messages", "role"] {
            assert!(keys.contains(&expected.to_string()), "missing {expected}");
        }
    }
}
