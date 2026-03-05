//! Persona presets for the AI agent.

use serde::{Deserialize, Serialize};

use bc_ai_chat::system;

/// A named persona preset.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
}

/// Get all available presets.
pub fn available_presets() -> Vec<Preset> {
    system::available_presets()
        .into_iter()
        .map(|(id, desc)| Preset {
            id: id.to_string(),
            name: id
                .split('-')
                .map(|w| {
                    let mut c = w.chars();
                    match c.next() {
                        None => String::new(),
                        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
            description: desc.to_string(),
            system_prompt: system::preset_system_prompt(id),
        })
        .collect()
}

/// Get a preset by ID.
pub fn get_preset(id: &str) -> Option<Preset> {
    available_presets().into_iter().find(|p| p.id == id)
}
