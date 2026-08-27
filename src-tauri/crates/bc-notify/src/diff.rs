//! Snapshot diff for DNS records (keyed by record id).

use std::collections::HashMap;

use bc_cloudflare_api::DNSRecord;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::model::{Notification, NotificationKind};
use crate::settings::NotificationSettings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Removed,
    Changed,
}

impl ChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeKind::Added => "added",
            ChangeKind::Removed => "removed",
            ChangeKind::Changed => "changed",
        }
    }
}

/// Record fields that can participate in change detection (`kinds.recordChange.fields`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DiffField {
    Content,
    Ttl,
    Proxied,
    Priority,
    Comment,
    Name,
    Type,
}

impl DiffField {
    pub const fn all() -> &'static [DiffField] {
        &[
            DiffField::Content,
            DiffField::Ttl,
            DiffField::Proxied,
            DiffField::Priority,
            DiffField::Comment,
            DiffField::Name,
            DiffField::Type,
        ]
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DiffField::Content => "content",
            DiffField::Ttl => "ttl",
            DiffField::Proxied => "proxied",
            DiffField::Priority => "priority",
            DiffField::Comment => "comment",
            DiffField::Name => "name",
            DiffField::Type => "type",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        DiffField::all()
            .iter()
            .copied()
            .find(|field| field.as_str() == value)
    }
}

/// The comparable subset of a record (before/after payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordValues {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxied: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordFingerprint {
    pub id: String,
    pub record_type: String,
    pub name: String,
    pub values: RecordValues,
    pub modified_on: String,
}

impl RecordFingerprint {
    pub fn from_record(record: &DNSRecord) -> Option<Self> {
        let id = record.id.clone()?;
        Some(Self {
            id,
            record_type: record.r#type.clone(),
            name: record.name.clone(),
            values: RecordValues {
                content: record.content.clone(),
                ttl: record.ttl,
                proxied: record.proxied,
                priority: record.priority,
                comment: record.comment.clone(),
            },
            modified_on: record.modified_on.clone(),
        })
    }

    fn differs(&self, other: &Self, field: DiffField) -> bool {
        match field {
            DiffField::Content => self.values.content != other.values.content,
            DiffField::Ttl => self.values.ttl != other.values.ttl,
            DiffField::Proxied => self.values.proxied != other.values.proxied,
            DiffField::Priority => self.values.priority != other.values.priority,
            DiffField::Comment => self.values.comment != other.values.comment,
            DiffField::Name => self.name != other.name,
            DiffField::Type => self.record_type != other.record_type,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordChange {
    pub change: ChangeKind,
    pub record_id: String,
    pub record_type: String,
    pub record_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<RecordValues>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<RecordValues>,
    /// `modified_on` of the new record (or of the old one for removals) — dedupe input.
    pub modified_on: String,
    #[serde(default)]
    pub changed_fields: Vec<String>,
}

/// Compare two snapshots. Added = id only in `new`; removed = id only in `old`;
/// changed = same id and any selected `fields` differ. Records without an id are ignored.
pub fn diff_snapshots(
    old: &[DNSRecord],
    new: &[DNSRecord],
    fields: &[DiffField],
) -> Vec<RecordChange> {
    let fields: Vec<DiffField> = if fields.is_empty() {
        DiffField::all().to_vec()
    } else {
        fields.to_vec()
    };
    let old_map: HashMap<String, RecordFingerprint> = old
        .iter()
        .filter_map(RecordFingerprint::from_record)
        .map(|fp| (fp.id.clone(), fp))
        .collect();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut changes = Vec::new();

    for record in new {
        let Some(fp) = RecordFingerprint::from_record(record) else {
            continue;
        };
        if !seen.insert(fp.id.clone()) {
            continue;
        }
        match old_map.get(&fp.id) {
            None => changes.push(RecordChange {
                change: ChangeKind::Added,
                record_id: fp.id.clone(),
                record_type: fp.record_type.clone(),
                record_name: fp.name.clone(),
                before: None,
                after: Some(fp.values.clone()),
                modified_on: fp.modified_on.clone(),
                changed_fields: Vec::new(),
            }),
            Some(previous) => {
                let changed: Vec<String> = fields
                    .iter()
                    .filter(|field| previous.differs(&fp, **field))
                    .map(|field| field.as_str().to_string())
                    .collect();
                if !changed.is_empty() {
                    changes.push(RecordChange {
                        change: ChangeKind::Changed,
                        record_id: fp.id.clone(),
                        record_type: fp.record_type.clone(),
                        record_name: fp.name.clone(),
                        before: Some(previous.values.clone()),
                        after: Some(fp.values.clone()),
                        modified_on: fp.modified_on.clone(),
                        changed_fields: changed,
                    });
                }
            }
        }
    }

    let mut removed: Vec<&RecordFingerprint> = old_map
        .values()
        .filter(|fp| !seen.contains(&fp.id))
        .collect();
    removed.sort_by(|a, b| a.id.cmp(&b.id));
    for fp in removed {
        changes.push(RecordChange {
            change: ChangeKind::Removed,
            record_id: fp.id.clone(),
            record_type: fp.record_type.clone(),
            record_name: fp.name.clone(),
            before: Some(fp.values.clone()),
            after: None,
            modified_on: fp.modified_on.clone(),
            changed_fields: Vec::new(),
        });
    }
    changes
}

pub fn change_dedupe_key(zone_id: &str, change: &RecordChange) -> String {
    format!(
        "change:{zone_id}:{}:{}:{}",
        change.record_id,
        change.modified_on,
        change.change.as_str()
    )
}

fn describe_values(values: &RecordValues) -> String {
    let mut parts = vec![values.content.clone()];
    if let Some(ttl) = values.ttl {
        parts.push(format!("TTL {ttl}"));
    }
    if let Some(true) = values.proxied {
        parts.push("proxied".to_string());
    }
    if let Some(priority) = values.priority {
        parts.push(format!("priority {priority}"));
    }
    parts.join(", ")
}

pub fn build_change_notification(
    settings: &NotificationSettings,
    zone_id: &str,
    zone_name: &str,
    change: &RecordChange,
    now: DateTime<Utc>,
) -> Notification {
    let severity = settings.severity_for_change(change.change);
    let label = format!("{} {}", change.record_type, change.record_name);
    let (title, body) = match change.change {
        ChangeKind::Added => (
            format!("Record added: {label}"),
            format!(
                "A new record appeared in {zone_name} outside this app: {}",
                change
                    .after
                    .as_ref()
                    .map(describe_values)
                    .unwrap_or_default()
            ),
        ),
        ChangeKind::Removed => (
            format!("Record removed: {label}"),
            format!(
                "A record was deleted from {zone_name} outside this app. It was: {}",
                change
                    .before
                    .as_ref()
                    .map(describe_values)
                    .unwrap_or_default()
            ),
        ),
        ChangeKind::Changed => (
            format!("Record changed: {label}"),
            format!(
                "{} changed in {zone_name} outside this app: {} \u{2192} {}",
                change.changed_fields.join(", "),
                change
                    .before
                    .as_ref()
                    .map(describe_values)
                    .unwrap_or_default(),
                change
                    .after
                    .as_ref()
                    .map(describe_values)
                    .unwrap_or_default()
            ),
        ),
    };
    Notification::new(
        NotificationKind::RecordChange,
        severity,
        title,
        body,
        change_dedupe_key(zone_id, change),
        json!({
            "change": change.change.as_str(),
            "recordId": change.record_id,
            "recordType": change.record_type,
            "recordName": change.record_name,
            "before": change.before,
            "after": change.after,
            "changedFields": change.changed_fields,
        }),
        now,
    )
    .with_zone(zone_id, zone_name)
}
