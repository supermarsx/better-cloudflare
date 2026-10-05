//! Unit tests for bc-notify (no network; temp directories only).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;

use bc_cloudflare_api::DNSRecord;
use bc_registrar::types::{
    DNSSECStatus, DomainInfo, DomainLocks, DomainStatus, Nameservers, PrivacyStatus,
    RegistrarProvider,
};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde_json::{json, Value};

use crate::diff::{diff_snapshots, ChangeKind, DiffField};
use crate::expiry::{due_milestone, normalize_milestones, parse_rdap_expiry};
use crate::ledger::OwnChangeLedger;
use crate::model::{format_ts, Notification, NotificationKind, NotificationQuery, Scope, Severity};
use crate::rdap::is_valid_hostname;
use crate::settings::{
    AuditMinSeverity, ExpirySource, MinSeverity, NotificationSettings, QuietBehaviour,
    SeverityMode, ToastMinSeverity, ZoneMode, ZoneOverride,
};
use crate::store::{AuditFindingState, NotifyStore};
use crate::{
    deliver, evaluate_expiry_milestones, reconcile_findings, record_expiry, run_audit_pass,
    run_expiry_pass_with, run_record_pass, PassKind, PassReport, RdapClient, ZoneRef, ZoneSource,
    RESOLVED_EPISODE_RETENTION_DAYS,
};

// ── helpers ──────────────────────────────────────────────────────────────────

fn ts(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text)
        .expect("rfc3339")
        .with_timezone(&Utc)
}

fn now() -> DateTime<Utc> {
    ts("2026-03-01T12:00:00Z")
}

fn record(id: &str, kind: &str, name: &str, content: &str) -> DNSRecord {
    DNSRecord {
        id: Some(id.to_string()),
        r#type: kind.to_string(),
        name: name.to_string(),
        content: content.to_string(),
        comment: None,
        ttl: Some(300),
        priority: None,
        proxied: Some(false),
        zone_id: "z1".to_string(),
        zone_name: "example.com".to_string(),
        created_on: "2026-01-01T00:00:00Z".to_string(),
        modified_on: "2026-01-01T00:00:00Z".to_string(),
    }
}

fn notification(kind: NotificationKind, key: &str, at: DateTime<Utc>) -> Notification {
    Notification::new(kind, Severity::Info, key, "body", key, Value::Null, at)
}

fn temp_store() -> (tempfile::TempDir, NotifyStore) {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = NotifyStore::open(dir.path().join("notifications")).expect("open store");
    (dir, store)
}

fn settings_json(value: Value) -> NotificationSettings {
    NotificationSettings::from_value(&value)
}

struct FakeSource {
    zones: Vec<ZoneRef>,
    records: HashMap<String, Vec<DNSRecord>>,
    fail_zones: bool,
    calls: Mutex<Vec<String>>,
}

impl FakeSource {
    fn new(zones: &[(&str, &str)]) -> Self {
        Self {
            zones: zones
                .iter()
                .map(|(id, name)| ZoneRef {
                    id: id.to_string(),
                    name: name.to_string(),
                })
                .collect(),
            records: HashMap::new(),
            fail_zones: false,
            calls: Mutex::new(Vec::new()),
        }
    }

    fn with_records(mut self, zone_id: &str, records: Vec<DNSRecord>) -> Self {
        self.records.insert(zone_id.to_string(), records);
        self
    }

    fn checked_zones(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl ZoneSource for FakeSource {
    async fn list_zones(&self) -> Result<Vec<ZoneRef>, String> {
        if self.fail_zones {
            return Err("HTTP 503 server error".to_string());
        }
        Ok(self.zones.clone())
    }

    async fn list_records(
        &self,
        zone_id: &str,
        page: u32,
        _per_page: u32,
    ) -> Result<Vec<DNSRecord>, String> {
        if page == 1 {
            self.calls.lock().unwrap().push(zone_id.to_string());
        }
        if page > 1 {
            return Ok(Vec::new());
        }
        self.records
            .get(zone_id)
            .cloned()
            .ok_or_else(|| format!("zone {zone_id} returned HTTP 500"))
    }
}

fn domain_info(domain: &str, expires_at: &str) -> DomainInfo {
    DomainInfo {
        domain: domain.to_string(),
        registrar: RegistrarProvider::Porkbun,
        status: DomainStatus::Active,
        created_at: "2020-01-01T00:00:00Z".to_string(),
        expires_at: expires_at.to_string(),
        updated_at: None,
        nameservers: Nameservers {
            current: vec![],
            is_custom: false,
        },
        locks: DomainLocks {
            transfer_lock: true,
            auto_renew: false,
        },
        dnssec: DNSSECStatus {
            enabled: false,
            ds_records: None,
        },
        privacy: PrivacyStatus {
            enabled: true,
            service_name: None,
        },
        contact: None,
    }
}

async fn record_pass(
    source: &FakeSource,
    store: &mut NotifyStore,
    ledger: &OwnChangeLedger,
    audit: &HashSet<String>,
    settings: &NotificationSettings,
    at: DateTime<Utc>,
) -> PassReport {
    run_record_pass(source, store, ledger, audit, settings, at).await
}

// ── milestones ───────────────────────────────────────────────────────────────

#[test]
fn milestones_first_run_at_20_days_emits_only_30_and_marks_larger() {
    let milestones = normalize_milestones(vec![90, 60, 30, 14, 7, 3, 1]);
    let (due, newly) = due_milestone(20, &milestones, &HashSet::new());
    assert_eq!(due, Some(30));
    assert_eq!(newly, vec![30, 60, 90]);
}

#[test]
fn milestones_next_day_nothing_then_14_then_expired() {
    let milestones = vec![90, 60, 30, 14, 7, 3, 1];
    let emitted: HashSet<u32> = [30, 60, 90].into_iter().collect();
    assert_eq!(due_milestone(19, &milestones, &emitted), (None, vec![]));
    let (due, newly) = due_milestone(14, &milestones, &emitted);
    assert_eq!((due, newly), (Some(14), vec![14]));
    let emitted: HashSet<u32> = [14, 30, 60, 90].into_iter().collect();
    let (due, newly) = due_milestone(-1, &milestones, &emitted);
    assert_eq!(due, Some(0));
    assert_eq!(newly, vec![0, 1, 3, 7]);
}

#[test]
fn milestones_expired_is_implicit_even_with_empty_list() {
    assert_eq!(due_milestone(0, &[], &HashSet::new()), (Some(0), vec![0]));
    assert_eq!(due_milestone(5, &[], &HashSet::new()), (None, vec![]));
}

#[test]
fn normalize_milestones_dedups_sorts_clamps() {
    assert_eq!(normalize_milestones(vec![1, 1, 400, 30, 0]), vec![30, 1]);
    let many: Vec<u32> = (1..=14).collect();
    assert_eq!(normalize_milestones(many).len(), 12);
    assert_eq!(normalize_milestones(vec![]), Vec::<u32>::new());
}

#[test]
fn renewal_resets_emitted_milestones() {
    let (_dir, mut store) = temp_store();
    let settings = NotificationSettings::default();
    let expires = now() + Duration::days(20);
    record_expiry(&mut store, "example.com", Some(expires), "rdap", now());
    let mut report = PassReport::new(PassKind::Expiry, now());
    assert_eq!(
        evaluate_expiry_milestones(&mut store, &settings, now(), &mut report),
        1
    );
    assert_eq!(
        store.state().expiry["example.com"].emitted,
        vec![30, 60, 90]
    );
    // Same date again: nothing new.
    assert_eq!(
        evaluate_expiry_milestones(&mut store, &settings, now(), &mut report),
        0
    );
    // Renewed for a year: ledger cleared, no milestone due.
    record_expiry(
        &mut store,
        "example.com",
        Some(expires + Duration::days(365)),
        "rdap",
        now(),
    );
    assert!(store.state().expiry["example.com"].emitted.is_empty());
    assert_eq!(
        evaluate_expiry_milestones(&mut store, &settings, now(), &mut report),
        0
    );
    let items = store.list(&NotificationQuery::default());
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].kind, NotificationKind::DomainExpiry);
    assert_eq!(items[0].payload["milestone"], json!(30));
    assert_eq!(items[0].payload["daysLeft"], json!(20));
    assert_eq!(items[0].severity, Severity::Info);
}

#[test]
fn expired_notice_is_critical_and_respects_notify_expired() {
    let (_dir, mut store) = temp_store();
    let mut settings = NotificationSettings::default();
    record_expiry(
        &mut store,
        "old.com",
        Some(now() - Duration::days(2)),
        "rdap",
        now(),
    );
    settings.expiry.notify_expired = false;
    let mut report = PassReport::new(PassKind::Expiry, now());
    assert_eq!(
        evaluate_expiry_milestones(&mut store, &settings, now(), &mut report),
        0
    );
    assert!(store.state().expiry["old.com"].emitted.contains(&0));
    // A fresh domain with notify_expired on.
    settings.expiry.notify_expired = true;
    record_expiry(
        &mut store,
        "gone.com",
        Some(now() - Duration::days(2)),
        "registrar",
        now(),
    );
    assert_eq!(
        evaluate_expiry_milestones(&mut store, &settings, now(), &mut report),
        1
    );
    let item = &store.list(&NotificationQuery::default())[0];
    assert_eq!(item.severity, Severity::Critical);
    assert!(item.title.contains("has expired"));
    assert_eq!(item.payload["source"], json!("registrar"));
}

// ── diff ─────────────────────────────────────────────────────────────────────

#[test]
fn diff_added_removed_changed_unchanged() {
    let old = vec![
        record("a", "A", "www.example.com", "1.1.1.1"),
        record("b", "A", "old.example.com", "2.2.2.2"),
        record("c", "TXT", "example.com", "v=spf1 -all"),
    ];
    let mut changed = record("a", "A", "www.example.com", "9.9.9.9");
    changed.modified_on = "2026-02-01T00:00:00Z".into();
    let new = vec![
        changed,
        record("c", "TXT", "example.com", "v=spf1 -all"),
        record("d", "CNAME", "cdn.example.com", "cdn.example.net"),
    ];
    let changes = diff_snapshots(&old, &new, DiffField::all());
    let kinds: Vec<(ChangeKind, &str)> = changes
        .iter()
        .map(|c| (c.change, c.record_id.as_str()))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (ChangeKind::Changed, "a"),
            (ChangeKind::Added, "d"),
            (ChangeKind::Removed, "b")
        ]
    );
    let change = &changes[0];
    assert_eq!(change.changed_fields, vec!["content"]);
    assert_eq!(change.before.as_ref().unwrap().content, "1.1.1.1");
    assert_eq!(change.after.as_ref().unwrap().content, "9.9.9.9");
    assert_eq!(change.modified_on, "2026-02-01T00:00:00Z");
}

#[test]
fn diff_proxied_flip_counts_and_fields_filter_applies() {
    let old = vec![record("a", "A", "www.example.com", "1.1.1.1")];
    let mut flipped = record("a", "A", "www.example.com", "1.1.1.1");
    flipped.proxied = Some(true);
    let new = vec![flipped];
    let changes = diff_snapshots(&old, &new, DiffField::all());
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].changed_fields, vec!["proxied"]);
    // Only content selected: the proxied flip is invisible.
    assert!(diff_snapshots(&old, &new, &[DiffField::Content]).is_empty());
}

#[test]
fn diff_ignores_records_without_id() {
    let mut anon = record("x", "A", "a.example.com", "1.1.1.1");
    anon.id = None;
    assert!(diff_snapshots(&[], &[anon], DiffField::all()).is_empty());
}

#[tokio::test]
async fn record_pass_first_run_is_baseline_only() {
    let (_dir, mut store) = temp_store();
    let source = FakeSource::new(&[("z1", "example.com")])
        .with_records("z1", vec![record("a", "A", "www.example.com", "1.1.1.1")]);
    let settings = NotificationSettings::default();
    let ledger = OwnChangeLedger::new();
    let report = record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        now(),
    )
    .await;
    assert_eq!(report.zones_checked, 1);
    assert_eq!(report.notifications_created, 0);
    assert_eq!(report.errors, 0);
    assert!(store.has_snapshot("z1"));
    assert_eq!(store.load_snapshot("z1").unwrap().unwrap().len(), 1);
    assert_eq!(store.state().zones["z1"].snapshot_records, Some(1));
    assert!(store.state().last_record_check_at.is_some());
}

#[tokio::test]
async fn record_pass_reports_external_change_with_before_after() {
    let (_dir, mut store) = temp_store();
    let settings = NotificationSettings::default();
    let ledger = OwnChangeLedger::new();
    let source = FakeSource::new(&[("z1", "example.com")])
        .with_records("z1", vec![record("a", "A", "www.example.com", "1.1.1.1")]);
    record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        now(),
    )
    .await;

    let mut edited = record("a", "A", "www.example.com", "8.8.8.8");
    edited.modified_on = "2026-03-01T11:00:00Z".into();
    let source = FakeSource::new(&[("z1", "example.com")]).with_records(
        "z1",
        vec![edited, record("b", "MX", "example.com", "mail.example.com")],
    );
    let later = now() + Duration::minutes(15);
    let report = record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        later,
    )
    .await;
    assert_eq!(report.notifications_created, 2);
    let items = store.list(&NotificationQuery::default());
    assert_eq!(items.len(), 2);
    let changed = items
        .iter()
        .find(|n| n.payload["change"] == json!("changed"))
        .expect("changed item");
    assert_eq!(changed.zone_id.as_deref(), Some("z1"));
    assert_eq!(changed.payload["before"]["content"], json!("1.1.1.1"));
    assert_eq!(changed.payload["after"]["content"], json!("8.8.8.8"));
    assert_eq!(changed.severity, Severity::Warning);
    assert!(changed.body.contains("1.1.1.1"));
    // Running again with the same data: nothing new (snapshot advanced, dedupe).
    let report = record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        later,
    )
    .await;
    assert_eq!(report.notifications_created, 0);
}

#[tokio::test]
async fn record_pass_skips_own_changes_via_ledger_and_audit_backstop() {
    let (_dir, mut store) = temp_store();
    let settings = NotificationSettings::default();
    let ledger = OwnChangeLedger::new();
    let source = FakeSource::new(&[("z1", "example.com")]).with_records(
        "z1",
        vec![
            record("a", "A", "www.example.com", "1.1.1.1"),
            record("b", "A", "api.example.com", "1.1.1.2"),
            record("c", "A", "old.example.com", "1.1.1.3"),
        ],
    );
    record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        now(),
    )
    .await;

    ledger.note_at("z1", "a", "dns:update", now());
    let audit: HashSet<String> = ["b".to_string()].into_iter().collect();
    let source = FakeSource::new(&[("z1", "example.com")]).with_records(
        "z1",
        vec![
            record("a", "A", "www.example.com", "2.2.2.2"),
            record("b", "A", "api.example.com", "3.3.3.3"),
            record("c", "A", "old.example.com", "4.4.4.4"),
        ],
    );
    let report = record_pass(&source, &mut store, &ledger, &audit, &settings, now()).await;
    assert_eq!(report.notifications_created, 1);
    let items = store.list(&NotificationQuery::default());
    assert_eq!(items[0].payload["recordId"], json!("c"));
    assert!(
        !ledger.consume_at("z1", "a", now()),
        "ledger entry consumed"
    );
}

#[tokio::test]
async fn record_pass_removed_zone_drops_snapshot_and_notes_service() {
    let (_dir, mut store) = temp_store();
    let settings = NotificationSettings::default();
    let ledger = OwnChangeLedger::new();
    let source = FakeSource::new(&[("z1", "example.com"), ("z2", "gone.com")])
        .with_records("z1", vec![])
        .with_records("z2", vec![record("a", "A", "gone.com", "1.1.1.1")]);
    record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        now(),
    )
    .await;
    assert!(store.has_snapshot("z2"));
    let source = FakeSource::new(&[("z1", "example.com")]).with_records("z1", vec![]);
    let report = record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        now(),
    )
    .await;
    assert_eq!(report.notifications_created, 1);
    assert!(!store.has_snapshot("z2"));
    assert!(!store.state().zones.contains_key("z2"));
    let items = store.list(&NotificationQuery::default());
    assert_eq!(items[0].kind, NotificationKind::Service);
    assert_eq!(items[0].payload["event"], json!("zone_removed"));
}

#[tokio::test]
async fn record_pass_records_errors_and_backoff_hint() {
    let (_dir, mut store) = temp_store();
    let settings = NotificationSettings::default();
    let ledger = OwnChangeLedger::new();
    let mut source = FakeSource::new(&[("z1", "example.com")]);
    source.fail_zones = true;
    let report = record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        now(),
    )
    .await;
    assert_eq!(report.errors, 1);
    assert!(report.backoff);
    // Zone listing works but one zone fails: error recorded per zone, pass continues.
    let source =
        FakeSource::new(&[("z1", "example.com"), ("z2", "two.com")]).with_records("z2", vec![]);
    let report = record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        now(),
    )
    .await;
    assert_eq!(report.zones_checked, 1);
    assert_eq!(report.errors, 1);
    assert!(store.state().zones["z1"].last_error.is_some());
    assert!(store.state().zones["z2"].last_error.is_none());
}

// ── ledger ───────────────────────────────────────────────────────────────────

#[test]
fn ledger_ttl_and_cap() {
    let ledger = OwnChangeLedger::new();
    ledger.note_at("z", "r", "dns:update", now());
    assert!(ledger.consume_at("z", "r", now() + Duration::minutes(59)));
    ledger.note_at("z", "r", "dns:update", now());
    assert!(!ledger.consume_at("z", "r", now() + Duration::minutes(61)));
    for i in 0..10_500 {
        ledger.note_at("z", &format!("r{i}"), "dns:create", now());
    }
    assert_eq!(ledger.len(), crate::ledger::LEDGER_MAX_ENTRIES);
    assert!(!ledger.consume_at("z", "r0", now()));
    assert!(ledger.consume_at("z", "r10499", now()));
}

// ── store ────────────────────────────────────────────────────────────────────

#[test]
fn store_dedupes_by_key_while_unarchived() {
    let (_dir, mut store) = temp_store();
    let a = notification(NotificationKind::Service, "k1", now());
    let id = a.id.clone();
    assert!(store.insert_deduped(a).unwrap());
    assert!(!store
        .insert_deduped(notification(NotificationKind::Service, "k1", now()))
        .unwrap());
    assert_eq!(store.archive(&[id]).unwrap(), 1);
    assert!(store
        .insert_deduped(notification(NotificationKind::Service, "k1", now()))
        .unwrap());
    assert_eq!(store.len(), 2);
}

#[test]
fn store_unarchive_makes_item_dedupe_active_again() {
    let (_dir, mut store) = temp_store();
    let a = notification(NotificationKind::Service, "k1", now());
    let id = a.id.clone();
    store.insert_deduped(a).unwrap();
    assert_eq!(store.archive(std::slice::from_ref(&id)).unwrap(), 1);
    assert_eq!(store.unarchive(std::slice::from_ref(&id)).unwrap(), 1);
    assert_eq!(store.unarchive(std::slice::from_ref(&id)).unwrap(), 0);
    let item = store.get(&id).unwrap();
    assert!(!item.is_archived());
    assert!(
        !item.is_unread(),
        "archiving marked it read; unarchive keeps readAt"
    );
    assert!(!store
        .insert_deduped(notification(NotificationKind::Service, "k1", now()))
        .unwrap());
    assert_eq!(store.len(), 1);
    assert_eq!(store.list(&NotificationQuery::default()).len(), 1);
}

#[test]
fn store_mark_archive_dismiss_counts_and_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("n");
    let mut store = NotifyStore::open(&path).unwrap();
    let ids: Vec<String> = (0..3)
        .map(|i| {
            let n = notification(NotificationKind::Service, &format!("k{i}"), now());
            let id = n.id.clone();
            store.insert_deduped(n).unwrap();
            id
        })
        .collect();
    assert_eq!(store.unread_count(), 3);
    assert_eq!(store.mark_read(&ids[..2], true).unwrap(), 2);
    assert_eq!(store.mark_read(&ids[..2], true).unwrap(), 0);
    assert_eq!(store.unread_count(), 1);
    assert_eq!(store.mark_read(&ids[..1], false).unwrap(), 1);
    assert_eq!(store.mark_all_read().unwrap(), 2);
    assert_eq!(store.archive_all_read().unwrap(), 3);
    assert_eq!(store.unarchive(&ids[..1]).unwrap(), 1);
    assert_eq!(store.archive(&ids[..1]).unwrap(), 1);
    assert_eq!(store.dismiss(&ids[..1]).unwrap(), 1);
    assert_eq!(store.dismiss(&["nope".to_string()]).unwrap(), 0);
    assert_eq!(store.clear_archived().unwrap(), 2);
    assert!(store.is_empty());
    store
        .insert_deduped(notification(NotificationKind::Service, "again", now()))
        .unwrap();
    drop(store);
    let reopened = NotifyStore::open(&path).unwrap();
    assert_eq!(reopened.len(), 1);
    assert!(reopened.recovered_errors().is_empty());
}

#[test]
fn store_list_filters_scope_kind_zone_limit_cursor() {
    let (_dir, mut store) = temp_store();
    let mut a = notification(NotificationKind::RecordChange, "a", now());
    a = a.with_zone("z1", "example.com");
    let mut b = notification(
        NotificationKind::DomainExpiry,
        "b",
        now() + Duration::minutes(1),
    );
    b = b.with_zone("z2", "two.com");
    let c = notification(NotificationKind::Service, "c", now() + Duration::minutes(2));
    let a_id = a.id.clone();
    let c_id = c.id.clone();
    store.insert_many(vec![a, b, c]).unwrap();
    store.mark_read(std::slice::from_ref(&a_id), true).unwrap();
    store.archive(&[c_id]).unwrap();

    let all = store.list(&NotificationQuery::default());
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].dedupe_key, "b", "newest first");
    let unread = store.list(&NotificationQuery {
        scope: Scope::Unread,
        ..Default::default()
    });
    assert_eq!(unread.len(), 1);
    assert_eq!(unread[0].dedupe_key, "b");
    let archived = store.list(&NotificationQuery {
        scope: Scope::Archived,
        ..Default::default()
    });
    assert_eq!(archived.len(), 1);
    assert_eq!(archived[0].dedupe_key, "c");
    let by_kind = store.list(&NotificationQuery {
        kind: Some("record_change".into()),
        ..Default::default()
    });
    assert_eq!(by_kind.len(), 1);
    assert_eq!(by_kind[0].id, a_id);
    let by_zone = store.list(&NotificationQuery {
        zone_id: Some("z2".into()),
        ..Default::default()
    });
    assert_eq!(by_zone.len(), 1);
    let limited = store.list(&NotificationQuery {
        limit: Some(1),
        ..Default::default()
    });
    assert_eq!(limited.len(), 1);
    let before = store.list(&NotificationQuery {
        before: Some(all[0].created_at.clone()),
        ..Default::default()
    });
    assert_eq!(before.len(), 1);
    assert_eq!(before[0].dedupe_key, "a");
    assert!(store
        .list(&NotificationQuery {
            kind: Some("bogus".into()),
            ..Default::default()
        })
        .is_empty());
    assert_eq!(
        NotificationQuery {
            limit: Some(9999),
            ..Default::default()
        }
        .effective_limit(),
        500
    );
}

#[test]
fn store_prune_order_archived_then_read_then_unread() {
    let (_dir, mut store) = temp_store();
    store.set_max_items(10);
    let mut ids = Vec::new();
    for i in 0..5 {
        let n = notification(
            NotificationKind::Service,
            &format!("k{i}"),
            now() + Duration::minutes(i),
        );
        ids.push(n.id.clone());
        store.insert_deduped(n).unwrap();
    }
    // k0 unread (oldest), k1 read, k2 archived, k3 unread, k4 read.
    store
        .mark_read(&[ids[1].clone(), ids[4].clone()], true)
        .unwrap();
    store.archive(&[ids[2].clone()]).unwrap();
    store.set_max_items(3);
    assert_eq!(store.prune().unwrap(), 2);
    let remaining: Vec<&str> = store
        .items()
        .iter()
        .map(|n| n.dedupe_key.as_str())
        .collect();
    assert_eq!(remaining, vec!["k0", "k3", "k4"]);
    store.set_max_items(1);
    store.prune().unwrap();
    assert_eq!(store.items()[0].dedupe_key, "k3");
}

#[test]
fn store_recovers_from_corrupt_files_without_panic() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("n");
    std::fs::create_dir_all(path.join("snapshots")).unwrap();
    std::fs::write(path.join("inbox.json"), b"{not json").unwrap();
    std::fs::write(path.join("state.json"), b"\"nope\"").unwrap();
    std::fs::write(path.join("snapshots").join("z1.json"), b"garbage").unwrap();
    let mut store = NotifyStore::open(&path).unwrap();
    assert_eq!(store.recovered_errors().len(), 2);
    assert!(store.is_empty());
    assert!(store.load_snapshot("z1").is_err());
    assert!(store.load_snapshot("../etc").is_err());
    assert!(store.save_snapshot("bad/id", &[], now()).is_err());
    store
        .insert_deduped(notification(NotificationKind::Service, "ok", now()))
        .unwrap();
    let reopened = NotifyStore::open(&path).unwrap();
    assert_eq!(reopened.len(), 1);
    assert!(reopened.recovered_errors().is_empty());
}

#[test]
fn store_snapshot_roundtrip_and_delete() {
    let (_dir, mut store) = temp_store();
    let records = vec![record("a", "A", "www.example.com", "1.1.1.1")];
    store.save_snapshot("zone-1_A", &records, now()).unwrap();
    assert_eq!(store.snapshot_zone_ids(), vec!["zone-1_A"]);
    let loaded = store.load_snapshot("zone-1_A").unwrap().unwrap();
    assert_eq!(loaded[0].id.as_deref(), Some("a"));
    assert!(store.delete_snapshot("zone-1_A").unwrap());
    assert!(!store.delete_snapshot("zone-1_A").unwrap());
    assert!(store.load_snapshot("zone-1_A").unwrap().is_none());
}

// ── rdap ─────────────────────────────────────────────────────────────────────

#[test]
fn rdap_parses_expiration_event() {
    let body = json!({
        "objectClassName": "domain",
        "ldhName": "EXAMPLE.COM",
        "events": [
            { "eventAction": "registration", "eventDate": "1995-08-14T04:00:00Z" },
            { "eventAction": "expiration", "eventDate": "2026-08-13T04:00:00Z" },
            { "eventAction": "last changed", "eventDate": "2025-08-14T07:01:31Z" }
        ]
    });
    assert_eq!(parse_rdap_expiry(&body), Some(ts("2026-08-13T04:00:00Z")));
    assert_eq!(parse_rdap_expiry(&json!({ "events": [] })), None);
    assert_eq!(parse_rdap_expiry(&json!({})), None);
    let offset = json!({ "events": [{ "eventAction": "Expiration", "eventDate": "2026-08-13T06:00:00+02:00" }] });
    assert_eq!(parse_rdap_expiry(&offset), Some(ts("2026-08-13T04:00:00Z")));
}

#[test]
fn rdap_hostname_validation() {
    assert!(is_valid_hostname("example.com"));
    assert!(is_valid_hostname("xn--bcher-kva.example"));
    assert!(!is_valid_hostname("../etc"));
    assert!(!is_valid_hostname("exa mple.com"));
    assert!(!is_valid_hostname("example"));
    assert!(!is_valid_hostname("-bad.com"));
    assert!(!is_valid_hostname("bad-.com"));
    assert!(!is_valid_hostname("a..com"));
    assert!(!is_valid_hostname("exam/ple.com"));
    let long = format!("{}.com", "a".repeat(250));
    assert!(!is_valid_hostname(&long));
}

#[tokio::test]
async fn rdap_rejects_invalid_domain_before_any_request() {
    let client = reqwest::Client::new();
    let result =
        crate::rdap::fetch_rdap_expiry_from(&client, "http://127.0.0.1:9/domain/", "../x").await;
    assert!(matches!(result, Err(crate::rdap::RdapError::InvalidDomain)));
}

/// The domain argument is model-supplied, and it is interpolated into
/// `https://rdap.org/domain/<arg>`. Anything that could end the path segment
/// and start something else has to be refused before a URL exists.
#[test]
fn rdap_url_building_refuses_inputs_that_would_escape_the_path_segment() {
    for hostile in [
        "example.com/../../ip/8.8.8.8",
        "example.com/v1/nameserver/ns1.example",
        "example.com?redirect=evil.example",
        "example.com#fragment",
        "user:password@evil.example",
        "evil.example:8443",
        "https://evil.example/domain/example.com",
        "//evil.example/",
        "example.com%2f..%2fip%2f8.8.8.8",
        "exa\nmple.com",
        "example.com\u{0000}",
        "exa mple.com",
        "..",
        "../etc",
        "",
    ] {
        assert!(
            matches!(
                crate::rdap::rdap_domain_url(crate::rdap::RDAP_BASE_URL, hostile),
                Err(crate::rdap::RdapError::InvalidDomain)
            ),
            "{hostile:?} was accepted as a hostname"
        );
    }

    assert_eq!(
        crate::rdap::rdap_domain_url(crate::rdap::RDAP_BASE_URL, "  EXAMPLE.com.  ").unwrap(),
        "https://rdap.org/domain/example.com",
        "trimming, the root dot and ASCII case are normalisation, not escape"
    );
}

/// Validation is the first barrier; percent-encoding is the second. This pins
/// the encoder on its own, because by design nothing that needs encoding can
/// reach it through the public entry point.
#[test]
fn rdap_url_building_percent_encodes_as_a_second_barrier() {
    assert_eq!(
        crate::rdap::percent_encode_path_segment("a/b?c#d e%f:g@h"),
        "a%2Fb%3Fc%23d%20e%25f%3Ag%40h"
    );
    assert_eq!(
        crate::rdap::percent_encode_path_segment("example-domain.com"),
        "example-domain.com",
        "unreserved bytes pass through, so a legitimate lookup is unchanged"
    );
}

#[test]
fn rdap_redirects_are_https_only_and_depth_bounded() {
    use crate::rdap::{redirect_decision, RedirectDecision, RDAP_MAX_REDIRECTS};

    assert_eq!(redirect_decision(1, "https"), RedirectDecision::Follow);
    assert_eq!(
        redirect_decision(RDAP_MAX_REDIRECTS, "https"),
        RedirectDecision::Follow
    );
    assert_eq!(
        redirect_decision(RDAP_MAX_REDIRECTS + 1, "https"),
        RedirectDecision::TooDeep
    );
    for scheme in ["http", "HTTP", "file", "ftp", "data"] {
        assert_eq!(
            redirect_decision(1, scheme),
            RedirectDecision::StopNonHttps,
            "{scheme} redirect was followed"
        );
    }
}

/// A realistic registry answer, projected. The response carries registrant
/// contact data and terms-of-service prose; none of it may survive into the
/// value a caller (and then a language model) sees.
fn registry_document() -> Value {
    json!({
        "objectClassName": "domain",
        "handle": "2336799_DOMAIN_COM-VRSN",
        "ldhName": "EXAMPLE.COM",
        "unicodeName": "example.com",
        "port43": "whois.verisign-grs.com",
        "status": ["client delete prohibited", "clientTransferProhibited", "   "],
        "events": [
            { "eventAction": "registration", "eventDate": "1995-08-14T04:00:00Z" },
            { "eventAction": "expiration", "eventDate": "2026-08-13T04:00:00Z" },
            { "eventAction": "last changed", "eventDate": "2025-08-14T07:01:31Z" },
            { "eventAction": "last update of RDAP database", "eventDate": "2026-09-04T00:00:00Z" }
        ],
        "secureDNS": { "delegationSigned": true },
        "nameservers": [
            { "objectClassName": "nameserver", "ldhName": "A.IANA-SERVERS.NET." },
            { "objectClassName": "nameserver", "ldhName": "B.IANA-SERVERS.NET" },
            { "objectClassName": "nameserver", "ldhName": "not a hostname" }
        ],
        "entities": [
            {
                "objectClassName": "entity",
                "roles": ["registrant", "administrative"],
                "vcardArray": ["vcard", [
                    ["version", {}, "text", "4.0"],
                    ["fn", {}, "text", "Jane Doe"],
                    ["email", {}, "text", "jane@example.com"],
                    ["tel", {}, "uri", "tel:+1.5555550101"],
                    ["adr", {}, "text", ["", "", "1 Private Road", "Springfield", "", "", "US"]]
                ]]
            },
            {
                "objectClassName": "entity",
                "roles": ["registrar"],
                "publicIds": [{ "type": "IANA Registrar ID", "identifier": "292" }],
                "vcardArray": ["vcard", [
                    ["version", {}, "text", "4.0"],
                    ["fn", {}, "text", "RESERVED-Internet Assigned Numbers Authority"]
                ]],
                "entities": [{
                    "objectClassName": "entity",
                    "roles": ["abuse"],
                    "vcardArray": ["vcard", [
                        ["version", {}, "text", "4.0"],
                        ["fn", {}, "text", "Abuse Desk"],
                        ["email", {}, "text", "abuse@registrar.example"],
                        ["tel", { "type": ["voice"] }, "uri", "tel:+1.5555551212"]
                    ]]
                }]
            }
        ],
        "notices": [{
            "title": "Terms of Use",
            "description": ["Service subject to Terms of Use."]
        }]
    })
}

#[test]
fn rdap_projects_the_registry_fields_and_drops_contact_data() {
    let parsed = crate::rdap::parse_rdap_registration("example.com", &registry_document());

    assert_eq!(parsed.domain, "example.com");
    assert_eq!(parsed.registry_domain, None, "ldhName repeats the query");
    assert_eq!(parsed.unicode_name.as_deref(), Some("example.com"));
    assert_eq!(parsed.handle.as_deref(), Some("2336799_DOMAIN_COM-VRSN"));
    assert_eq!(
        parsed.registrar.as_deref(),
        Some("RESERVED-Internet Assigned Numbers Authority")
    );
    assert_eq!(parsed.registrar_iana_id.as_deref(), Some("292"));
    assert_eq!(
        parsed.statuses,
        vec!["client delete prohibited", "clientTransferProhibited"],
        "blank status entries are dropped"
    );
    assert_eq!(parsed.registered_at, Some(ts("1995-08-14T04:00:00Z")));
    assert_eq!(parsed.expires_at, Some(ts("2026-08-13T04:00:00Z")));
    assert_eq!(
        parsed.updated_at,
        Some(ts("2025-08-14T07:01:31Z")),
        "the domain's own change date beats the database refresh"
    );
    assert_eq!(
        parsed.nameservers,
        vec!["a.iana-servers.net", "b.iana-servers.net"],
        "nameservers are normalised and anything that is not a hostname is dropped"
    );
    assert_eq!(parsed.dnssec_signed, Some(true));
    assert_eq!(
        parsed.abuse_email.as_deref(),
        Some("abuse@registrar.example")
    );
    assert_eq!(parsed.abuse_phone.as_deref(), Some("+1.5555551212"));
    assert_eq!(
        parsed.whois_server.as_deref(),
        Some("whois.verisign-grs.com")
    );

    let serialized = serde_json::to_string(&parsed).unwrap();
    for leaked in [
        "Jane Doe",
        "jane@example.com",
        "Private Road",
        "Springfield",
        "5555550101",
        "Terms of Use",
    ] {
        assert!(
            !serialized.contains(leaked),
            "{leaked:?} reached the projected answer: {serialized}"
        );
    }

    let mut aliased = registry_document();
    aliased["ldhName"] = json!("WWW.EXAMPLE.COM");
    assert_eq!(
        crate::rdap::parse_rdap_registration("example.com", &aliased)
            .registry_domain
            .as_deref(),
        Some("www.example.com"),
        "a registry naming a different domain is reported, not silently adopted"
    );
}

#[test]
fn rdap_reads_no_registrar_fields_from_a_contacts_only_document() {
    let contacts_only = json!({
        "objectClassName": "domain",
        "ldhName": "example.com",
        "entities": [{
            "objectClassName": "entity",
            "roles": ["registrant", "technical", "billing"],
            "publicIds": [{ "type": "IANA Registrar ID", "identifier": "999" }],
            "vcardArray": ["vcard", [["fn", {}, "text", "Jane Doe"]]],
            "entities": [{
                "roles": ["abuse"],
                "vcardArray": ["vcard", [["email", {}, "text", "jane@example.com"]]]
            }]
        }],
        "events": [{ "eventAction": "last update of RDAP database", "eventDate": "2026-09-04" }]
    });
    let parsed = crate::rdap::parse_rdap_registration("example.com", &contacts_only);

    assert_eq!(parsed.registrar, None);
    assert_eq!(parsed.registrar_iana_id, None);
    assert_eq!(parsed.abuse_email, None);
    assert_eq!(parsed.abuse_phone, None);
    assert_eq!(
        parsed.updated_at,
        Some(ts("2026-09-04T00:00:00Z")),
        "the database refresh date is used only when there is no 'last changed'"
    );
    assert_eq!(parsed.expires_at, None);
    assert!(parsed.statuses.is_empty());
    assert!(parsed.nameservers.is_empty());
}

#[test]
fn rdap_bounds_the_fields_a_hostile_registry_can_contribute() {
    let flood = json!({
        "ldhName": "example.com",
        "handle": format!("\u{1b}[31m{}", "h".repeat(crate::rdap::RDAP_MAX_FIELD_BYTES * 4)),
        "status": (0..crate::rdap::RDAP_MAX_STATUSES * 4)
            .map(|index| format!("status-{index}"))
            .collect::<Vec<_>>(),
        "nameservers": (0..crate::rdap::RDAP_MAX_NAMESERVERS * 4)
            .map(|index| json!({ "ldhName": format!("ns{index}.example.com") }))
            .collect::<Vec<_>>()
    });
    let parsed = crate::rdap::parse_rdap_registration("example.com", &flood);

    assert_eq!(
        parsed.handle.as_deref().map(str::len),
        Some(crate::rdap::RDAP_MAX_FIELD_BYTES)
    );
    assert!(
        !parsed.handle.unwrap().contains('\u{1b}'),
        "control bytes are stripped before a field is published"
    );
    assert_eq!(parsed.statuses.len(), crate::rdap::RDAP_MAX_STATUSES);
    assert_eq!(parsed.nameservers.len(), crate::rdap::RDAP_MAX_NAMESERVERS);
}

/// One-shot HTTP/1.1 stub: answers the first request with `response`, then
/// closes. Just enough protocol to satisfy reqwest — the bounds under test
/// live in `rdap.rs`, not here.
async fn serve_once(response: Vec<u8>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        let mut request = Vec::new();
        let mut buffer = [0u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            match socket.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => request.extend_from_slice(&buffer[..read]),
            }
        }
        let _ = socket.write_all(&response).await;
        let _ = socket.flush().await;
        let _ = socket.shutdown().await;
    });
    format!("http://127.0.0.1:{port}/domain/")
}

fn http_response(headers: &str, body: &[u8]) -> Vec<u8> {
    let mut response = headers.as_bytes().to_vec();
    response.extend_from_slice(body);
    response
}

#[tokio::test]
async fn rdap_returns_the_registration_over_http() {
    let body = serde_json::to_vec(&registry_document()).unwrap();
    let base = serve_once(http_response(
        &format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/rdap+json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        ),
        &body,
    ))
    .await;

    let registration = crate::rdap::fetch_rdap_registration_from(
        &crate::rdap::default_client(),
        &base,
        "EXAMPLE.com.",
    )
    .await
    .unwrap();

    assert_eq!(registration.domain, "example.com");
    assert_eq!(registration.expires_at, Some(ts("2026-08-13T04:00:00Z")));
    assert_eq!(
        registration.registrar.as_deref(),
        Some("RESERVED-Internet Assigned Numbers Authority")
    );
}

/// A registry that declares no length still may not stream an unbounded
/// document into memory — or into a model's context.
#[tokio::test]
async fn rdap_refuses_an_oversized_response_with_no_declared_length() {
    let padding = "h".repeat(crate::rdap::RDAP_MAX_BODY_BYTES);
    let body = format!(
        "{{\"objectClassName\":\"domain\",\"ldhName\":\"example.com\",\"handle\":\"{padding}\"}}"
    );
    assert!(body.len() > crate::rdap::RDAP_MAX_BODY_BYTES);
    let base = serve_once(http_response(
        "HTTP/1.1 200 OK\r\nContent-Type: application/rdap+json\r\nConnection: close\r\n\r\n",
        body.as_bytes(),
    ))
    .await;

    let result = crate::rdap::fetch_rdap_registration_from(
        &crate::rdap::default_client(),
        &base,
        "example.com",
    )
    .await;
    assert!(
        matches!(result, Err(crate::rdap::RdapError::TooLarge)),
        "an unbounded body was accepted: {result:?}"
    );
}

#[tokio::test]
async fn rdap_refuses_a_response_that_declares_an_oversized_length() {
    let declared = crate::rdap::RDAP_MAX_BODY_BYTES + 1;
    let base = serve_once(http_response(
        &format!("HTTP/1.1 200 OK\r\nContent-Length: {declared}\r\n\r\n"),
        &vec![b'h'; declared],
    ))
    .await;

    let result = crate::rdap::fetch_rdap_registration_from(
        &crate::rdap::default_client(),
        &base,
        "example.com",
    )
    .await;
    assert!(
        matches!(result, Err(crate::rdap::RdapError::TooLarge)),
        "a declared oversized length was accepted: {result:?}"
    );
}

/// `rdap.org` is a redirector, so where it points matters. A redirect that
/// leaves HTTPS is not followed: the 3xx comes back as a status error instead
/// of a request to the downgraded URL (which here would be a connect failure
/// against the discard port, a different error entirely).
#[tokio::test]
async fn rdap_does_not_follow_a_redirect_off_https() {
    let base = serve_once(http_response(
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/domain/example.com\r\nContent-Length: 0\r\n\r\n",
        b"",
    ))
    .await;

    let result = crate::rdap::fetch_rdap_registration_from(
        &crate::rdap::default_client(),
        &base,
        "example.com",
    )
    .await;
    assert!(
        matches!(result, Err(crate::rdap::RdapError::Status(302))),
        "a downgraded redirect was followed: {result:?}"
    );
}

// ── expiry pass (registrar source, no network) ───────────────────────────────

#[tokio::test]
async fn expiry_pass_uses_registrar_data_and_emits_milestone() {
    let (_dir, mut store) = temp_store();
    let mut settings = NotificationSettings::default();
    settings.expiry.source = ExpirySource::Registrar;
    let source = FakeSource::new(&[("z1", "example.com"), ("z2", "other.com")]);
    let expires = (now() + Duration::days(10)).to_rfc3339();
    let domains = vec![domain_info("Example.com", &expires)];
    let rdap = RdapClient {
        http: reqwest::Client::new(),
        base_url: "http://127.0.0.1:9/domain/".into(),
        min_interval: std::time::Duration::ZERO,
    };
    let report = run_expiry_pass_with(&source, &domains, &mut store, &settings, now(), &rdap).await;
    assert_eq!(report.kind, PassKind::Expiry);
    assert_eq!(report.zones_checked, 2);
    assert_eq!(report.errors, 0, "{:?}", report.error_messages);
    assert_eq!(report.notifications_created, 1);
    let state = &store.state().expiry["example.com"];
    assert_eq!(state.source.as_deref(), Some("registrar"));
    assert_eq!(state.emitted, vec![14, 30, 60, 90]);
    assert!(
        !store.state().expiry.contains_key("other.com"),
        "registrar-only mode never hits RDAP"
    );
    let item = &store.list(&NotificationQuery::default())[0];
    assert_eq!(item.zone_id.as_deref(), Some("z1"));
    assert_eq!(item.payload["milestone"], json!(14));
    assert_eq!(item.severity, Severity::Warning);
    assert!(store.state().last_expiry_check_at.is_some());
}

#[tokio::test]
async fn expiry_pass_skips_disabled_kind_and_unmonitored_zones() {
    let (_dir, mut store) = temp_store();
    let mut settings = NotificationSettings::default();
    settings.expiry.source = ExpirySource::Registrar;
    settings.zones.exclude = vec!["z1".into()];
    let source = FakeSource::new(&[("z1", "example.com")]);
    let domains = vec![domain_info("example.com", "2026-03-05")];
    let rdap = RdapClient::default();
    let report = run_expiry_pass_with(&source, &domains, &mut store, &settings, now(), &rdap).await;
    assert_eq!(report.zones_checked, 0);
    settings.zones.exclude.clear();
    settings.kinds.domain_expiry.enabled = false;
    let report = run_expiry_pass_with(&source, &domains, &mut store, &settings, now(), &rdap).await;
    assert!(report.skipped);
}

// ── settings ─────────────────────────────────────────────────────────────────

fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/fixtures/notification-settings.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("fixture json")
}

#[test]
fn settings_defaults_match_shared_fixture() {
    let fixture = fixture();
    let defaults = serde_json::to_value(NotificationSettings::default()).unwrap();
    assert_eq!(defaults, fixture["defaults"]);
    assert_eq!(
        serde_json::to_value(NotificationSettings::default().normalize()).unwrap(),
        fixture["defaults"],
        "defaults are a fixed point of normalize()"
    );
    assert_eq!(
        serde_json::from_value::<NotificationSettings>(fixture["defaults"].clone()).unwrap(),
        NotificationSettings::default()
    );
}

#[test]
fn settings_shared_fixture_cases_pass() {
    let fixture = fixture();
    let defaults = fixture["defaults"].clone();
    for case in fixture["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap_or("?");
        let expected = match &case["expectedNormalized"] {
            Value::String(s) if s == "$defaults" => defaults.clone(),
            Value::Object(map) => {
                let mut merged = defaults.as_object().cloned().unwrap();
                for (key, value) in map {
                    if key != "$defaults" {
                        merged.insert(key.clone(), value.clone());
                    }
                }
                Value::Object(merged)
            }
            other => panic!("{name}: bad expectedNormalized {other}"),
        };
        let actual =
            serde_json::to_value(NotificationSettings::from_value(&case["input"])).unwrap();
        assert_eq!(actual, expected, "fixture case: {name}");
    }
}

#[test]
fn settings_partial_and_garbage_never_fail() {
    let s = settings_json(json!({ "service": { "enabled": false } }));
    assert!(!s.service.enabled);
    assert_eq!(s.service.record_poll_minutes, 15);
    let garbage = settings_json(json!("not an object"));
    assert_eq!(garbage, NotificationSettings::default());
    let wrong_type = settings_json(json!({ "service": { "recordPollMinutes": "soon" } }));
    assert_eq!(wrong_type.service, Default::default());
    let bad_retention = settings_json(json!({ "retention": { "maxItems": -5 } }));
    assert_eq!(bad_retention.retention, Default::default());
}

#[test]
fn settings_unknown_kind_key_dropped_and_zone_precedence() {
    let s = settings_json(json!({
        "kinds": { "pigeon": { "enabled": true } },
        "zones": { "mode": "all", "include": ["z1"], "exclude": ["z1", "z2"] }
    }));
    assert!(!serde_json::to_value(&s).unwrap()["kinds"]
        .as_object()
        .unwrap()
        .contains_key("pigeon"));
    // mode all: exclude wins over include.
    assert!(!s.is_zone_monitored("z1"));
    assert!(!s.is_zone_monitored("z2"));
    assert!(s.is_zone_monitored("z3"));
    // allowlist: only include counts; exclude ignored.
    let mut allow = s.clone();
    allow.zones.mode = ZoneMode::Allowlist;
    assert!(allow.is_zone_monitored("z1"));
    assert!(!allow.is_zone_monitored("z3"));
}

#[test]
fn settings_zone_mute_and_kind_overrides() {
    let s = settings_json(json!({
        "zones": { "overrides": {
            "m": { "muted": true },
            "t": { "mutedUntil": "2999-01-01T00:00:00Z" },
            "e": { "mutedUntil": "2000-01-01T00:00:00Z" },
            "k": { "kinds": { "recordChange": false } }
        } }
    }));
    assert!(s.is_zone_muted("m", now()));
    assert!(s.is_zone_muted("t", now()));
    assert!(!s.zones.overrides.contains_key("e"), "expired mute cleared");
    assert!(!s.is_zone_muted("e", now()));
    assert!(!s.zone_kind_enabled("k", NotificationKind::RecordChange));
    assert!(s.zone_kind_enabled("k", NotificationKind::DomainExpiry));
    assert!(s.zone_kind_enabled("m", NotificationKind::RecordChange));
    let mut global_off = s.clone();
    global_off.kinds.domain_expiry.enabled = false;
    assert!(!global_off.zone_kind_enabled("k", NotificationKind::DomainExpiry));
    // mutedUntil that is still in the future but then passes.
    let o = ZoneOverride {
        muted: false,
        muted_until: Some("2026-03-01T13:00:00Z".into()),
        kinds: None,
    };
    assert!(o.is_muted(now()));
    assert!(!o.is_muted(now() + Duration::hours(2)));
}

#[test]
fn settings_quiet_hours_across_midnight_and_day_filter() {
    let s = settings_json(
        json!({ "quietHours": { "enabled": true, "start": "22:00", "end": "07:00", "timezone": "UTC" } }),
    );
    let day = NaiveDate::from_ymd_opt(2026, 3, 4).unwrap(); // Wednesday
    assert!(s.quiet_hours.covers(day.and_hms_opt(23, 30, 0).unwrap()));
    assert!(s.quiet_hours.covers(day.and_hms_opt(6, 59, 0).unwrap()));
    assert!(!s.quiet_hours.covers(day.and_hms_opt(7, 0, 0).unwrap()));
    assert!(!s.quiet_hours.covers(day.and_hms_opt(12, 0, 0).unwrap()));
    assert!(s.quiet_hours.covers(day.and_hms_opt(22, 0, 0).unwrap()));
    assert!(s.quiet_hours_active(Utc.with_ymd_and_hms(2026, 3, 4, 23, 30, 0).unwrap()));
    assert!(!s.quiet_hours_active(Utc.with_ymd_and_hms(2026, 3, 4, 8, 0, 0).unwrap()));
    // Weekdays only (1..5): Saturday 23:30 is outside.
    let weekdays = settings_json(
        json!({ "quietHours": { "enabled": true, "days": [1,2,3,4,5], "timezone": "UTC" } }),
    );
    let saturday = NaiveDate::from_ymd_opt(2026, 3, 7).unwrap();
    assert!(!weekdays
        .quiet_hours
        .covers(saturday.and_hms_opt(23, 30, 0).unwrap()));
    assert!(weekdays
        .quiet_hours
        .covers(day.and_hms_opt(23, 30, 0).unwrap()));
    // Same-day window and IANA zone: 09:00–17:00 Europe/Lisbon (UTC+0 in March, before DST).
    let office = settings_json(
        json!({ "quietHours": { "enabled": true, "start": "09:00", "end": "17:00", "timezone": "Europe/Lisbon" } }),
    );
    assert!(office.quiet_hours_active(Utc.with_ymd_and_hms(2026, 3, 4, 10, 0, 0).unwrap()));
    assert!(!office.quiet_hours_active(Utc.with_ymd_and_hms(2026, 3, 4, 18, 0, 0).unwrap()));
    let end = s
        .quiet_hours
        .window_end(Utc.with_ymd_and_hms(2026, 3, 4, 23, 30, 0).unwrap())
        .unwrap();
    assert_eq!(end, Utc.with_ymd_and_hms(2026, 3, 5, 7, 0, 0).unwrap());
    let disabled = settings_json(json!({ "quietHours": { "enabled": true, "start": "9:00" } }));
    assert!(!disabled.quiet_hours.enabled);
}

#[test]
fn settings_hold_releases_with_original_created_at() {
    let (_dir, mut store) = temp_store();
    let s = settings_json(
        json!({ "quietHours": { "enabled": true, "start": "22:00", "end": "07:00", "timezone": "UTC", "behaviour": "hold" } }),
    );
    let quiet = Utc.with_ymd_and_hms(2026, 3, 4, 23, 0, 0).unwrap();
    let n = notification(NotificationKind::RecordChange, "held", quiet);
    assert!(deliver(&mut store, &s, n, quiet).unwrap());
    assert!(store.is_empty());
    assert_eq!(store.held_count(), 1);
    // Still quiet: nothing released.
    assert_eq!(
        crate::release_if_quiet_over(&mut store, &s, quiet + Duration::hours(1)).unwrap(),
        0
    );
    // Held items survive a restart.
    let dir = store.dir().to_path_buf();
    drop(store);
    let mut store = NotifyStore::open(&dir).unwrap();
    assert_eq!(store.held_count(), 1);
    let morning = Utc.with_ymd_and_hms(2026, 3, 5, 8, 0, 0).unwrap();
    assert_eq!(
        crate::release_if_quiet_over(&mut store, &s, morning).unwrap(),
        1
    );
    assert_eq!(store.held_count(), 0);
    let items = store.list(&NotificationQuery::default());
    assert_eq!(items[0].created_at, crate::format_ts(quiet));
    // Silence behaviour inserts immediately.
    let silence = settings_json(
        json!({ "quietHours": { "enabled": true, "start": "22:00", "end": "07:00", "timezone": "UTC" } }),
    );
    assert!(deliver(
        &mut store,
        &silence,
        notification(NotificationKind::Service, "s", quiet),
        quiet
    )
    .unwrap());
    assert_eq!(store.len(), 2);
}

#[test]
fn settings_severity_mapping_auto_and_fixed() {
    let s = NotificationSettings::default();
    assert_eq!(s.severity_for_expiry(60), Severity::Info);
    assert_eq!(s.severity_for_expiry(14), Severity::Warning);
    assert_eq!(s.severity_for_expiry(7), Severity::Warning);
    assert_eq!(s.severity_for_expiry(3), Severity::Critical);
    assert_eq!(s.severity_for_expiry(0), Severity::Critical);
    assert_eq!(s.severity_for_change(ChangeKind::Added), Severity::Warning);
    assert_eq!(
        s.severity_for_change(ChangeKind::Changed),
        Severity::Warning
    );
    assert_eq!(
        s.severity_for_change(ChangeKind::Removed),
        Severity::Critical
    );
    assert_eq!(s.severity_for_service(), Severity::Info);
    let mut fixed = s.clone();
    fixed.kinds.domain_expiry.severity = SeverityMode::Info;
    fixed.kinds.record_change.severity = SeverityMode::Critical;
    assert_eq!(fixed.severity_for_expiry(0), Severity::Info);
    assert_eq!(
        fixed.severity_for_change(ChangeKind::Added),
        Severity::Critical
    );
    let custom = settings_json(
        json!({ "expiry": { "severityByMilestone": { "warningAtOrBelow": 30, "criticalAtOrBelow": 7 } } }),
    );
    assert_eq!(custom.severity_for_expiry(30), Severity::Warning);
    assert_eq!(custom.severity_for_expiry(7), Severity::Critical);
}

#[test]
fn settings_os_notify_allowed_rules() {
    let quiet_now = Utc.with_ymd_and_hms(2026, 3, 4, 23, 0, 0).unwrap();
    let base = settings_json(json!({ "zones": { "overrides": { "m": { "muted": true } } } }));
    let kind = NotificationKind::RecordChange;
    assert!(base.os_notify_allowed(kind, Severity::Warning, Some("z1"), now()));
    assert!(
        !base.os_notify_allowed(kind, Severity::Info, Some("z1"), now()),
        "minSeverity"
    );
    assert!(
        !base.os_notify_allowed(kind, Severity::Critical, Some("m"), now()),
        "zone mute"
    );
    assert!(
        !base.os_notify_allowed(NotificationKind::Service, Severity::Critical, None, now()),
        "kind osNotify off"
    );
    let mut kind_off = base.clone();
    kind_off.kinds.record_change.os_notify = false;
    assert!(!kind_off.os_notify_allowed(kind, Severity::Critical, None, now()));
    let mut all_off = base.clone();
    all_off.os_notifications.enabled = false;
    assert!(!all_off.os_notify_allowed(kind, Severity::Critical, None, now()));
    let mut info = base.clone();
    info.os_notifications.min_severity = MinSeverity::Info;
    assert!(info.os_notify_allowed(kind, Severity::Info, None, now()));
    let quiet = settings_json(
        json!({ "quietHours": { "enabled": true, "start": "22:00", "end": "07:00", "timezone": "UTC" } }),
    );
    assert!(!quiet.os_notify_allowed(kind, Severity::Critical, None, quiet_now));
    assert!(quiet.os_notify_allowed(kind, Severity::Critical, None, now()));
    assert!(!quiet.toast_allowed(Severity::Critical, quiet_now));
    assert!(quiet.toast_allowed(Severity::Critical, now()));
    assert!(!quiet.toast_allowed(Severity::Warning, now()));
}

#[test]
fn settings_retention_auto_archive_purge_cap_and_never() {
    let (_dir, mut store) = temp_store();
    let mut s = NotificationSettings::default();
    s.retention.auto_archive_read_after_days = Some(30);
    s.retention.purge_archived_after_days = Some(90);
    let old_read = notification(
        NotificationKind::Service,
        "old-read",
        now() - Duration::days(100),
    );
    let old_read_id = old_read.id.clone();
    let old_archived = notification(
        NotificationKind::Service,
        "old-archived",
        now() - Duration::days(200),
    );
    let old_archived_id = old_archived.id.clone();
    let fresh = notification(NotificationKind::Service, "fresh", now());
    store
        .insert_many(vec![old_read, old_archived, fresh])
        .unwrap();
    // Backdate read/archived stamps directly (the store stamps "now" on mutation).
    store
        .mark_read(std::slice::from_ref(&old_read_id), true)
        .unwrap();
    store
        .archive(std::slice::from_ref(&old_archived_id))
        .unwrap();
    for item in store.list(&NotificationQuery {
        scope: Scope::All,
        ..Default::default()
    }) {
        let _ = item;
    }
    // apply with "now" far in the future so the stamps count as old.
    let future = now() + Duration::days(400);
    let affected = store.apply_retention(&s.retention, future).unwrap();
    assert!(
        affected >= 2,
        "auto-archived read item and purged archived item: {affected}"
    );
    assert!(store.get(&old_archived_id).is_none(), "purged");
    assert!(
        store.get(&old_read_id).unwrap().is_archived(),
        "auto-archived"
    );
    assert!(!store
        .get(
            &store
                .items()
                .iter()
                .find(|n| n.dedupe_key == "fresh")
                .unwrap()
                .id
                .clone()
        )
        .unwrap()
        .is_archived());

    // null = never.
    let (_dir2, mut store2) = temp_store();
    let mut never = NotificationSettings::default();
    never.retention.auto_archive_read_after_days = None;
    never.retention.purge_archived_after_days = None;
    let a = notification(NotificationKind::Service, "a", now() - Duration::days(1000));
    let a_id = a.id.clone();
    let b = notification(NotificationKind::Service, "b", now() - Duration::days(1000));
    let b_id = b.id.clone();
    store2.insert_many(vec![a, b]).unwrap();
    store2.mark_read(std::slice::from_ref(&a_id), true).unwrap();
    store2.archive(std::slice::from_ref(&b_id)).unwrap();
    store2
        .apply_retention(&never.retention, now() + Duration::days(2000))
        .unwrap();
    assert!(!store2.get(&a_id).unwrap().is_archived());
    assert!(store2.get(&b_id).is_some());

    // maxItems cap via retention.
    let (_dir3, mut store3) = temp_store();
    let mut capped = NotificationSettings::default();
    capped.retention.max_items = 100;
    for i in 0..105 {
        store3
            .insert_deduped(notification(
                NotificationKind::Service,
                &format!("k{i}"),
                now() + Duration::seconds(i),
            ))
            .unwrap();
    }
    store3.apply_retention(&capped.retention, now()).unwrap();
    assert_eq!(store3.len(), 100);
    assert!(store3.items().iter().all(|n| n.dedupe_key != "k0"));
}

#[tokio::test]
async fn keep_snapshots_false_deletes_snapshots_and_skips_record_pass() {
    let (_dir, mut store) = temp_store();
    let mut s = NotificationSettings::default();
    let ledger = OwnChangeLedger::new();
    let source = FakeSource::new(&[("z1", "example.com")])
        .with_records("z1", vec![record("a", "A", "x.example.com", "1.1.1.1")]);
    record_pass(&source, &mut store, &ledger, &HashSet::new(), &s, now()).await;
    assert!(store.has_snapshot("z1"));
    s.retention.keep_snapshots = false;
    let report = record_pass(&source, &mut store, &ledger, &HashSet::new(), &s, now()).await;
    assert!(report.skipped);
    assert_eq!(report.zones_checked, 0);
    assert!(!store.has_snapshot("z1"));
    assert_eq!(
        source.checked_zones().len(),
        1,
        "no network in the skipped pass"
    );
    s.retention.keep_snapshots = true;
    s.kinds.record_change.enabled = false;
    let report = record_pass(&source, &mut store, &ledger, &HashSet::new(), &s, now()).await;
    assert!(report.skipped);
}

#[tokio::test]
async fn max_zones_per_pass_round_robin_covers_all_zones() {
    let (_dir, mut store) = temp_store();
    let mut s = NotificationSettings::default();
    s.service.max_zones_per_pass = 2;
    let ledger = OwnChangeLedger::new();
    let source = FakeSource::new(&[("z1", "a.com"), ("z2", "b.com"), ("z3", "c.com")])
        .with_records("z1", vec![])
        .with_records("z2", vec![])
        .with_records("z3", vec![]);
    let r1 = record_pass(&source, &mut store, &ledger, &HashSet::new(), &s, now()).await;
    assert_eq!(r1.zones_checked, 2);
    assert_eq!(store.state().zone_cursor, 2);
    let r2 = record_pass(&source, &mut store, &ledger, &HashSet::new(), &s, now()).await;
    assert_eq!(r2.zones_checked, 2);
    assert_eq!(source.checked_zones(), vec!["z1", "z2", "z3", "z1"]);
    assert_eq!(store.state().zone_cursor, 1);
    assert_eq!(store.snapshot_zone_ids(), vec!["z1", "z2", "z3"]);
}

#[tokio::test]
async fn record_pass_respects_zone_mute_kind_toggle_and_sub_kinds() {
    let (_dir, mut store) = temp_store();
    let s = settings_json(json!({
        "kinds": { "recordChange": { "changes": { "removed": false } } },
        "zones": { "overrides": { "muted": { "muted": true }, "off": { "kinds": { "recordChange": false } } } }
    }));
    let ledger = OwnChangeLedger::new();
    let base = |id: &str| {
        vec![
            record("a", "A", "x", "1.1.1.1"),
            record("b", "A", "y", "1.1.1.1"),
        ]
        .into_iter()
        .map(|mut r| {
            r.zone_id = id.into();
            r
        })
        .collect::<Vec<_>>()
    };
    let source = FakeSource::new(&[
        ("open", "open.com"),
        ("muted", "muted.com"),
        ("off", "off.com"),
    ])
    .with_records("open", base("open"))
    .with_records("muted", base("muted"))
    .with_records("off", base("off"));
    record_pass(&source, &mut store, &ledger, &HashSet::new(), &s, now()).await;
    // Everywhere: record a changed, record b removed.
    let edited = |id: &str| {
        vec![{
            let mut r = record("a", "A", "x", "2.2.2.2");
            r.zone_id = id.into();
            r
        }]
    };
    let source = FakeSource::new(&[
        ("open", "open.com"),
        ("muted", "muted.com"),
        ("off", "off.com"),
    ])
    .with_records("open", edited("open"))
    .with_records("muted", edited("muted"))
    .with_records("off", edited("off"));
    let report = record_pass(&source, &mut store, &ledger, &HashSet::new(), &s, now()).await;
    assert_eq!(
        report.zones_checked, 3,
        "muted zones still keep their snapshot fresh"
    );
    assert_eq!(report.notifications_created, 1);
    let items = store.list(&NotificationQuery::default());
    assert_eq!(items[0].zone_id.as_deref(), Some("open"));
    assert_eq!(items[0].payload["change"], json!("changed"));
    // Snapshots advanced for every zone, so nothing repeats next time.
    let report = record_pass(&source, &mut store, &ledger, &HashSet::new(), &s, now()).await;
    assert_eq!(report.notifications_created, 0);
}

#[test]
fn notification_wire_shape_is_camel_case() {
    let n = Notification::new(
        NotificationKind::DomainExpiry,
        Severity::Critical,
        "t",
        "b",
        "k",
        json!({ "domain": "example.com" }),
        now(),
    )
    .with_zone("z1", "example.com");
    let value = serde_json::to_value(&n).unwrap();
    assert_eq!(value["kind"], json!("domain_expiry"));
    assert_eq!(value["severity"], json!("critical"));
    assert_eq!(value["zoneId"], json!("z1"));
    assert_eq!(value["zoneName"], json!("example.com"));
    assert_eq!(value["createdAt"], json!("2026-03-01T12:00:00.000Z"));
    assert_eq!(value["readAt"], Value::Null);
    assert_eq!(value["archivedAt"], Value::Null);
    assert_eq!(value["dedupeKey"], json!("k"));
    let query: NotificationQuery =
        serde_json::from_value(json!({ "scope": "unread", "zoneId": "z1", "limit": 5 })).unwrap();
    assert_eq!(query.scope, Scope::Unread);
    assert_eq!(query.zone_id.as_deref(), Some("z1"));
    assert_eq!(query.effective_limit(), 5);
    let report = PassReport::new(PassKind::Records, now());
    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(value["kind"], json!("records"));
    assert!(value.get("zonesChecked").is_some());
}

// ── audit findings ───────────────────────────────────────────────────────────

/// A zone with mail configured and SPF published, but no DMARC record. With
/// `categories: ["email"]` and a `fail` threshold that is exactly one finding:
/// `dmarc-missing`. Dropping the SPF record or the MX changes which findings
/// fire and at what severity, which the escalation test relies on.
fn audit_records(zone: &str) -> Vec<DNSRecord> {
    vec![
        record("mx1", "MX", zone, &format!("mail.{zone}")),
        record("a1", "A", zone, "104.16.1.1"),
        record("t1", "TXT", zone, "v=spf1 -all"),
    ]
}

fn dmarc_record(zone: &str) -> DNSRecord {
    record(
        "t2",
        "TXT",
        &format!("_dmarc.{zone}"),
        "v=DMARC1; p=reject; rua=mailto:dmarc@example.com",
    )
}

fn audit_settings(categories: Value, min_finding_severity: &str) -> NotificationSettings {
    settings_json(json!({
        "kinds": { "auditFinding": {
            "enabled": true,
            "minFindingSeverity": min_finding_severity,
            "categories": categories,
        } }
    }))
}

fn email_audit_settings(min_finding_severity: &str) -> NotificationSettings {
    audit_settings(json!(["email"]), min_finding_severity)
}

fn audit_source(zones: &[(&str, &str)]) -> FakeSource {
    let mut source = FakeSource::new(zones);
    for (id, name) in zones {
        source = source.with_records(id, audit_records(name));
    }
    source
}

fn finding_ids(store: &NotifyStore) -> Vec<String> {
    let mut ids: Vec<String> = store
        .list(&NotificationQuery::default())
        .iter()
        .map(|n| n.payload["findingId"].as_str().unwrap_or("?").to_string())
        .collect();
    ids.sort();
    ids
}

#[test]
fn audit_kind_wire_name_round_trips_and_filters_the_inbox() {
    for (kind, wire) in [
        (NotificationKind::DomainExpiry, "domain_expiry"),
        (NotificationKind::RecordChange, "record_change"),
        (NotificationKind::Service, "service"),
        (NotificationKind::AuditFinding, "audit_finding"),
    ] {
        assert_eq!(kind.as_str(), wire);
        assert_eq!(NotificationKind::parse(wire), Some(kind));
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(wire));
        assert_eq!(
            serde_json::from_value::<NotificationKind>(json!(wire)).unwrap(),
            kind
        );
    }
    assert_eq!(NotificationKind::parse("audit"), None);

    let (_dir, mut store) = temp_store();
    store
        .insert_deduped(notification(NotificationKind::AuditFinding, "a", now()))
        .unwrap();
    store
        .insert_deduped(notification(NotificationKind::RecordChange, "r", now()))
        .unwrap();
    let query = NotificationQuery {
        kind: Some("audit_finding".into()),
        ..Default::default()
    };
    let listed = store.list(&query);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].kind, NotificationKind::AuditFinding);
}

/// Mutation proof (c): rename `PassKind::Audit`, or give it a `serde(rename)`,
/// and this test fails. Folding the audit's own kind enum into `PassKind` was
/// meant to be a rename of Rust names only — `lastPass.kind` is read by the
/// frontend, so each tag is pinned here against the string it had before.
#[test]
fn pass_kind_wire_strings_survive_the_enum_collapse() {
    for (kind, wire) in [
        (PassKind::Records, "records"),
        (PassKind::Expiry, "expiry"),
        (PassKind::Audit, "audit"),
    ] {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(wire));
        assert_eq!(
            serde_json::from_value::<PassKind>(json!(wire)).unwrap(),
            kind
        );
        let value = serde_json::to_value(PassReport::new(kind, now())).unwrap();
        assert_eq!(value["kind"], json!(wire), "report tag for {wire}");
        assert!(value.get("zonesChecked").is_some());
    }
}

/// Mutation proof (a): flip `enabled` to `true` in
/// `AuditFindingKindSettings::default` and this test fails on the first assert.
#[tokio::test]
async fn audit_kind_is_disabled_by_default_and_the_pass_skips() {
    let defaults = NotificationSettings::default();
    assert!(
        !defaults.kinds.audit_finding.enabled,
        "a new kind must not start spending API calls on upgrade"
    );
    assert!(!defaults.kinds.audit_finding.os_notify);
    let (_dir, mut store) = temp_store();
    let source = audit_source(&[("z1", "example.com")]);
    let report = run_audit_pass(&source, &mut store, &defaults, now()).await;
    assert!(report.skipped);
    assert_eq!(report.notifications_created, 0);
    assert_eq!(report.zones_checked, 0);
    assert!(
        source.checked_zones().is_empty(),
        "disabled means no records are read at all"
    );
}

#[tokio::test]
async fn audit_pass_notifies_a_new_finding_with_an_actionable_body() {
    let (_dir, mut store) = temp_store();
    let settings = email_audit_settings("fail");
    let source = audit_source(&[("z1", "example.com")]);
    let report = run_audit_pass(&source, &mut store, &settings, now()).await;
    assert_eq!(report.zones_checked, 1);
    assert_eq!(report.notifications_created, 1);
    assert_eq!(report.errors, 0);
    assert!(!report.skipped);

    let items = store.list(&NotificationQuery::default());
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.kind, NotificationKind::AuditFinding);
    assert_eq!(
        item.severity,
        Severity::Critical,
        "a fail finding is critical"
    );
    assert_eq!(item.zone_id.as_deref(), Some("z1"));
    assert_eq!(item.zone_name.as_deref(), Some("example.com"));
    assert_eq!(item.payload["findingId"], json!("dmarc-missing"));
    assert_eq!(item.payload["category"], json!("email"));
    assert_eq!(item.payload["auditSeverity"], json!("fail"));
    assert_eq!(item.payload["regressed"], json!(false));
    assert!(item.title.starts_with("example.com: "), "{}", item.title);
    assert!(item.body.contains("example.com"), "the body names the zone");
    assert!(
        item.body
            .contains("No DMARC TXT record found at _dmarc.example.com"),
        "the body states the finding: {}",
        item.body
    );
    assert!(
        item.body.contains("Suggested record") && item.body.contains("v=DMARC1"),
        "the body says what to do: {}",
        item.body
    );
    assert_eq!(
        item.dedupe_key,
        "audit:z1:dmarc-missing:fail:2026-03-01T12:00:00.000Z"
    );

    let state = &store.state().audit["z1"];
    assert_eq!(
        state.last_audited_at.as_deref(),
        Some("2026-03-01T12:00:00.000Z")
    );
    assert!(state.last_error.is_none());
    let episode = &state.findings["dmarc-missing"];
    assert_eq!(episode.severity, "fail");
    assert_eq!(episode.first_seen_at, "2026-03-01T12:00:00.000Z");
    assert_eq!(episode.resolved_at, None);
    assert_eq!(
        store.state().last_audit_check_at.as_deref(),
        Some("2026-03-01T12:00:00.000Z")
    );
}

/// Mutation proof (b): in `audit::reconcile_findings`, make the `Some(state)`
/// arm open a fresh episode (`first_seen_at: stamp.clone()`) and push an alert
/// like the `None` arm does, and this test fails on the second pass.
#[tokio::test]
async fn audit_pass_does_not_renotify_an_open_finding() {
    let (_dir, mut store) = temp_store();
    let settings = email_audit_settings("fail");
    let source = audit_source(&[("z1", "example.com")]);
    let first = run_audit_pass(&source, &mut store, &settings, now()).await;
    assert_eq!(first.notifications_created, 1);

    let later = now() + Duration::days(1);
    let second = run_audit_pass(&source, &mut store, &settings, later).await;
    assert_eq!(
        second.notifications_created, 0,
        "the same open finding must not notify every poll"
    );
    let third = run_audit_pass(&source, &mut store, &settings, later + Duration::days(1)).await;
    assert_eq!(third.notifications_created, 0);
    assert_eq!(store.items().len(), 1);

    let episode = &store.state().audit["z1"].findings["dmarc-missing"];
    assert_eq!(
        episode.first_seen_at, "2026-03-01T12:00:00.000Z",
        "the episode keeps the start it was opened with"
    );
    assert_eq!(episode.last_seen_at, "2026-03-03T12:00:00.000Z");
}

#[tokio::test]
async fn audit_pass_renotifies_after_a_finding_is_fixed_and_regresses() {
    let (_dir, mut store) = temp_store();
    let settings = email_audit_settings("fail");
    let broken = audit_source(&[("z1", "example.com")]);
    let mut fixed_records = audit_records("example.com");
    fixed_records.push(dmarc_record("example.com"));
    let fixed = FakeSource::new(&[("z1", "example.com")]).with_records("z1", fixed_records);

    let first = run_audit_pass(&broken, &mut store, &settings, now()).await;
    assert_eq!(first.notifications_created, 1);

    let fixed_at = now() + Duration::days(1);
    let second = run_audit_pass(&fixed, &mut store, &settings, fixed_at).await;
    assert_eq!(second.notifications_created, 0);
    assert_eq!(
        store.state().audit["z1"].findings["dmarc-missing"]
            .resolved_at
            .as_deref(),
        Some("2026-03-02T12:00:00.000Z"),
        "the episode closes when the finding stops being reported"
    );

    let regressed_at = fixed_at + Duration::days(1);
    let third = run_audit_pass(&broken, &mut store, &settings, regressed_at).await;
    assert_eq!(
        third.notifications_created, 1,
        "a finding that comes back must notify again"
    );

    let items = store.list(&NotificationQuery::default());
    assert_eq!(items.len(), 2);
    assert!(
        items.iter().all(|n| !n.is_archived()),
        "the first notice is still in the inbox, so the key had to change"
    );
    assert_ne!(items[0].dedupe_key, items[1].dedupe_key);
    let newest = &items[0];
    assert_eq!(newest.payload["regressed"], json!(true));
    assert!(
        newest.body.starts_with("This was fixed and has come back."),
        "{}",
        newest.body
    );
    assert_eq!(
        newest.dedupe_key,
        "audit:z1:dmarc-missing:fail:2026-03-03T12:00:00.000Z"
    );
    let episode = &store.state().audit["z1"].findings["dmarc-missing"];
    assert_eq!(episode.resolved_at, None);
    assert_eq!(episode.first_seen_at, "2026-03-03T12:00:00.000Z");
}

#[tokio::test]
async fn audit_pass_opens_a_new_episode_when_severity_escalates() {
    let (_dir, mut store) = temp_store();
    let settings = email_audit_settings("warn");
    // No MX: SPF and DMARC are missing, but only a warning.
    let quiet = FakeSource::new(&[("z1", "example.com")])
        .with_records("z1", vec![record("a1", "A", "example.com", "104.16.1.1")]);
    let first = run_audit_pass(&quiet, &mut store, &settings, now()).await;
    assert_eq!(first.notifications_created, 2);
    assert_eq!(finding_ids(&store), ["dmarc-missing", "spf-missing"]);
    assert_eq!(
        store.state().audit["z1"].findings["spf-missing"].severity,
        "warn"
    );

    // Mail arrives at the apex: the same two findings are now failures.
    let with_mail = FakeSource::new(&[("z1", "example.com")]).with_records(
        "z1",
        vec![
            record("a1", "A", "example.com", "104.16.1.1"),
            record("mx1", "MX", "example.com", "mail.example.com"),
        ],
    );
    let later = now() + Duration::days(1);
    let second = run_audit_pass(&with_mail, &mut store, &settings, later).await;
    assert!(second.notifications_created >= 2);

    let spf: Vec<&Notification> = store
        .items()
        .iter()
        .filter(|n| n.payload["findingId"] == json!("spf-missing"))
        .collect();
    assert_eq!(spf.len(), 2, "an escalation is news, not a repeat");
    let severities: HashSet<&str> = spf
        .iter()
        .filter_map(|n| n.payload["auditSeverity"].as_str())
        .collect();
    assert_eq!(severities, HashSet::from(["warn", "fail"]));
    assert_eq!(
        store.state().audit["z1"].findings["spf-missing"].severity,
        "fail"
    );
}

/// Mutation proof (c): replace the `continue` in `run_audit_pass`'s
/// `fetch_all_records` error arm with `break` (or `return`) and this test fails
/// — `z2` is never audited.
#[tokio::test]
async fn audit_pass_continues_after_one_zone_fails() {
    let (_dir, mut store) = temp_store();
    let settings = email_audit_settings("fail");
    // z1 has no records registered, so the fake source answers HTTP 500 for it.
    let source = FakeSource::new(&[("z1", "one.com"), ("z2", "two.com")])
        .with_records("z2", audit_records("two.com"));
    let report = run_audit_pass(&source, &mut store, &settings, now()).await;

    assert_eq!(report.errors, 1);
    assert!(report.backoff, "a 5xx from one zone still asks for backoff");
    assert_eq!(
        report.zones_checked, 1,
        "the zone after the failure was still audited"
    );
    assert_eq!(report.notifications_created, 1);
    assert_eq!(source.checked_zones(), vec!["z1", "z2"]);
    let items = store.list(&NotificationQuery::default());
    assert_eq!(items[0].zone_id.as_deref(), Some("z2"));
    assert!(store.state().audit["z1"].last_error.is_some());
    assert!(store.state().audit["z1"].findings.is_empty());
    assert!(store.state().audit["z2"].last_error.is_none());
}

#[tokio::test]
async fn audit_pass_respects_min_finding_severity_and_category_filter() {
    let source = audit_source(&[("z1", "example.com")]);

    let (_dir, mut store) = temp_store();
    let report = run_audit_pass(&source, &mut store, &email_audit_settings("warn"), now()).await;
    assert_eq!(report.notifications_created, 3);
    assert_eq!(
        finding_ids(&store),
        ["dkim-missing", "dmarc-missing", "mx-single"]
    );

    let (_dir, mut store) = temp_store();
    let report = run_audit_pass(&source, &mut store, &email_audit_settings("fail"), now()).await;
    assert_eq!(report.notifications_created, 1);
    assert_eq!(finding_ids(&store), ["dmarc-missing"]);

    // Hygiene only: not one email finding, however severe.
    let (_dir, mut store) = temp_store();
    let hygiene = audit_settings(json!(["hygiene"]), "warn");
    run_audit_pass(&source, &mut store, &hygiene, now()).await;
    assert_eq!(finding_ids(&store), ["apex-single-ip"]);

    // The audit's own domain-expiry finding is never raised here: the
    // domain_expiry kind owns that ground.
    let (_dir, mut store) = temp_store();
    let everything = audit_settings(json!(["email", "security", "hygiene"]), "info");
    run_audit_pass(&source, &mut store, &everything, now()).await;
    let ids = finding_ids(&store);
    assert!(!ids.is_empty());
    assert!(
        !ids.iter().any(|id| id == "domain-expiry"),
        "domain expiry belongs to the expiry pass: {ids:?}"
    );
    assert!(ids.iter().any(|id| id == "caa-analysis"), "{ids:?}");
}

#[tokio::test]
async fn audit_pass_is_bounded_by_max_zones_per_pass_and_keeps_its_own_cursor() {
    let (_dir, mut store) = temp_store();
    let mut settings = email_audit_settings("fail");
    settings.service.max_zones_per_pass = 1;
    let source = audit_source(&[("z1", "one.com"), ("z2", "two.com"), ("z3", "three.com")]);

    for (index, cursor) in [(0u32, 1u32), (1, 2), (2, 0)] {
        let at = now() + Duration::days(i64::from(index));
        let report = run_audit_pass(&source, &mut store, &settings, at).await;
        assert_eq!(report.zones_checked, 1, "pass {index} audited one zone");
        assert_eq!(store.state().audit_zone_cursor, cursor);
    }
    assert_eq!(source.checked_zones(), vec!["z1", "z2", "z3"]);
    assert_eq!(store.items().len(), 3, "one finding per zone, once each");
    assert_eq!(
        store.state().zone_cursor,
        0,
        "the audit pass never moves the record pass's cursor"
    );

    // ... and the record pass never moves the audit pass's cursor.
    let ledger = OwnChangeLedger::new();
    let before = store.state().audit_zone_cursor;
    record_pass(
        &source,
        &mut store,
        &ledger,
        &HashSet::new(),
        &settings,
        now(),
    )
    .await;
    assert_eq!(store.state().zone_cursor, 1);
    assert_eq!(store.state().audit_zone_cursor, before);
}

#[tokio::test]
async fn audit_pass_skips_muted_and_per_zone_disabled_zones() {
    let (_dir, mut store) = temp_store();
    let mut settings = email_audit_settings("fail");
    settings.zones.overrides = serde_json::from_value(json!({
        "z2": { "muted": true },
        "z3": { "kinds": { "auditFinding": false } },
    }))
    .unwrap();
    assert!(!settings.zone_kind_enabled("z3", NotificationKind::AuditFinding));
    assert!(settings.zone_kind_enabled("z3", NotificationKind::RecordChange));

    let source = audit_source(&[("z1", "one.com"), ("z2", "two.com"), ("z3", "three.com")]);
    let report = run_audit_pass(&source, &mut store, &settings, now()).await;
    assert_eq!(report.zones_checked, 1);
    assert_eq!(report.notifications_created, 1);
    assert_eq!(
        source.checked_zones(),
        vec!["z1"],
        "a muted or audit-disabled zone is not even read"
    );
}

#[tokio::test]
async fn audit_pass_reports_a_zone_listing_failure_and_asks_for_backoff() {
    let (_dir, mut store) = temp_store();
    let settings = email_audit_settings("fail");
    let mut source = audit_source(&[("z1", "example.com")]);
    source.fail_zones = true;
    let report = run_audit_pass(&source, &mut store, &settings, now()).await;
    assert_eq!(report.errors, 1);
    assert!(report.backoff);
    assert!(!report.skipped);
    assert_eq!(report.zones_checked, 0);
    assert!(report.error_messages[0].contains("list zones"));
}

#[tokio::test]
async fn audit_pass_forgets_episodes_for_zones_that_disappear() {
    let (_dir, mut store) = temp_store();
    let settings = email_audit_settings("fail");
    let both = audit_source(&[("z1", "one.com"), ("z2", "two.com")]);
    run_audit_pass(&both, &mut store, &settings, now()).await;
    assert_eq!(store.state().audit.len(), 2);

    let only_z2 = audit_source(&[("z2", "two.com")]);
    run_audit_pass(&only_z2, &mut store, &settings, now() + Duration::days(1)).await;
    assert!(!store.state().audit.contains_key("z1"));
    assert!(store.state().audit.contains_key("z2"));
}

#[test]
fn audit_reconcile_prunes_long_resolved_episodes() {
    let episode = |resolved_days_ago: i64| AuditFindingState {
        severity: "warn".into(),
        first_seen_at: format_ts(now() - Duration::days(resolved_days_ago + 1)),
        last_seen_at: format_ts(now() - Duration::days(resolved_days_ago)),
        resolved_at: Some(format_ts(now() - Duration::days(resolved_days_ago))),
    };
    let previous = BTreeMap::from([
        ("spf-missing".to_string(), episode(10)),
        (
            "dkim-missing".to_string(),
            episode(RESOLVED_EPISODE_RETENTION_DAYS + 5),
        ),
    ]);
    let (next, alerts) = reconcile_findings(&previous, &[], now());
    assert!(alerts.is_empty(), "nothing reported means nothing to say");
    assert_eq!(next.keys().collect::<Vec<_>>(), ["spf-missing"]);
}

#[test]
fn audit_settings_pre_change_payload_keeps_every_field() {
    // A settings file written before the audit kind existed, with every section
    // set away from its default so a reset would be obvious.
    let stored = json!({
        "version": 1,
        "service": {
            "enabled": false,
            "paused": true,
            "catchUpOnLaunch": false,
            "recordPollMinutes": 45,
            "expiryPollMinutes": 720,
            "rdapCacheHours": 48,
            "maxZonesPerPass": 25,
            "backoffMaxMinutes": 30
        },
        "kinds": {
            "domainExpiry": { "enabled": false, "severity": "critical", "osNotify": false },
            "recordChange": {
                "enabled": true,
                "severity": "warning",
                "osNotify": false,
                "changes": { "added": false, "changed": true, "removed": false },
                "fields": ["content", "ttl"]
            },
            "service": { "enabled": false, "severity": "warning", "osNotify": true }
        },
        "expiry": {
            "milestones": [45, 10],
            "notifyExpired": false,
            "source": "registrar",
            "severityByMilestone": { "warningAtOrBelow": 20, "criticalAtOrBelow": 5 }
        },
        "zones": {
            "mode": "allowlist",
            "include": ["keep-me"],
            "exclude": ["drop-me"],
            "overrides": { "keep-me": { "muted": true, "kinds": { "recordChange": false } } }
        },
        "quietHours": {
            "enabled": true,
            "start": "01:00",
            "end": "05:00",
            "days": [1, 2, 3],
            "timezone": "UTC",
            "behaviour": "hold"
        },
        "osNotifications": { "enabled": false, "minSeverity": "critical" },
        "inApp": { "toastMinSeverity": "info", "badge": false },
        "retention": {
            "autoArchiveReadAfterDays": 7,
            "purgeArchivedAfterDays": 14,
            "maxItems": 500,
            "keepSnapshots": false
        }
    });
    let s = settings_json(stored.clone());

    // Every pre-change field survives.
    assert!(!s.service.enabled);
    assert!(s.service.paused);
    assert!(!s.service.catch_up_on_launch);
    assert_eq!(s.service.record_poll_minutes, 45);
    assert_eq!(s.service.expiry_poll_minutes, 720);
    assert_eq!(s.service.rdap_cache_hours, 48);
    assert_eq!(s.service.max_zones_per_pass, 25);
    assert_eq!(s.service.backoff_max_minutes, 30);
    assert!(!s.kinds.domain_expiry.enabled);
    assert_eq!(s.kinds.domain_expiry.severity, SeverityMode::Critical);
    assert!(!s.kinds.domain_expiry.os_notify);
    assert!(s.kinds.record_change.enabled);
    assert_eq!(s.kinds.record_change.severity, SeverityMode::Warning);
    assert!(!s.kinds.record_change.os_notify);
    assert!(!s.kinds.record_change.changes.added);
    assert!(s.kinds.record_change.changes.changed);
    assert!(!s.kinds.record_change.changes.removed);
    assert_eq!(s.kinds.record_change.fields, vec!["content", "ttl"]);
    assert!(!s.kinds.service.enabled);
    assert!(s.kinds.service.os_notify);
    assert_eq!(s.expiry.milestones, vec![45, 10]);
    assert!(!s.expiry.notify_expired);
    assert_eq!(s.expiry.source, ExpirySource::Registrar);
    assert_eq!(s.expiry.severity_by_milestone.warning_at_or_below, 20);
    assert_eq!(s.expiry.severity_by_milestone.critical_at_or_below, 5);
    assert_eq!(s.zones.mode, ZoneMode::Allowlist);
    assert_eq!(s.zones.include, vec!["keep-me"]);
    assert_eq!(s.zones.exclude, vec!["drop-me"]);
    assert!(s.is_zone_muted("keep-me", now()));
    assert!(!s.zone_kind_enabled("keep-me", NotificationKind::RecordChange));
    assert!(s.quiet_hours.enabled);
    assert_eq!(s.quiet_hours.start, "01:00");
    assert_eq!(s.quiet_hours.end, "05:00");
    assert_eq!(s.quiet_hours.days, vec![1, 2, 3]);
    assert_eq!(s.quiet_hours.timezone, "UTC");
    assert_eq!(s.quiet_hours.behaviour, QuietBehaviour::Hold);
    assert!(!s.os_notifications.enabled);
    assert_eq!(s.os_notifications.min_severity, MinSeverity::Critical);
    assert_eq!(s.in_app.toast_min_severity, ToastMinSeverity::Info);
    assert!(!s.in_app.badge);
    assert_eq!(s.retention.auto_archive_read_after_days, Some(7));
    assert_eq!(s.retention.purge_archived_after_days, Some(14));
    assert_eq!(s.retention.max_items, 500);
    assert!(!s.retention.keep_snapshots);

    // The new fields arrive at their defaults, and off.
    assert_eq!(s.service.audit_poll_minutes, 1440);
    assert_eq!(s.kinds.audit_finding, Default::default());
    assert!(!s.kinds.audit_finding.enabled);
    assert_eq!(
        s.kinds.audit_finding.min_finding_severity,
        AuditMinSeverity::Warn
    );
    assert_eq!(
        s.kinds.audit_finding.categories,
        vec!["email", "security", "hygiene"]
    );
    assert_eq!(
        s.zones.overrides["keep-me"]
            .kinds
            .as_ref()
            .unwrap()
            .audit_finding,
        None
    );
    assert!(
        !s.zone_kind_enabled("keep-me", NotificationKind::AuditFinding),
        "the kind is off globally, so no zone has it on"
    );

    // Nothing but the new keys appears in the round trip.
    let round_tripped = serde_json::to_value(&s).unwrap();
    let mut service = round_tripped["service"].as_object().unwrap().clone();
    assert_eq!(service.remove("auditPollMinutes"), Some(json!(1440)));
    assert_eq!(Value::Object(service), stored["service"]);
    let mut kinds = round_tripped["kinds"].as_object().unwrap().clone();
    assert!(kinds.remove("auditFinding").is_some());
    assert_eq!(
        Value::Object(kinds)["domainExpiry"],
        stored["kinds"]["domainExpiry"]
    );
}

#[test]
fn audit_settings_normalize_clamps_poll_and_categories() {
    let fast = settings_json(json!({ "service": { "auditPollMinutes": 1 } }));
    assert_eq!(
        fast.service.audit_poll_minutes, 60,
        "an audit is heavier than a record diff, so the floor is an hour"
    );
    let slow = settings_json(json!({ "service": { "auditPollMinutes": 99_999 } }));
    assert_eq!(slow.service.audit_poll_minutes, 10_080);

    let bogus = audit_settings(json!(["pigeon"]), "warn");
    assert_eq!(
        bogus.kinds.audit_finding.categories,
        vec!["email", "security", "hygiene"],
        "an unusable filter resets to everything, as recordChange.fields does"
    );
    let dupes = audit_settings(json!(["hygiene", "email", "email"]), "warn");
    assert_eq!(
        dupes.kinds.audit_finding.categories,
        vec!["email", "hygiene"],
        "deduped into canonical order"
    );
    assert_eq!(
        audit_settings(json!([]), "warn")
            .kinds
            .audit_finding
            .categories,
        vec!["email", "security", "hygiene"]
    );

    let bad_threshold = audit_settings(json!(["email"]), "pass");
    assert_eq!(
        bad_threshold.kinds.audit_finding.min_finding_severity,
        AuditMinSeverity::Warn,
        "an unknown threshold falls back to the default, like every other enum"
    );
    // This field takes the audit's grades, not the notification severities, so
    // "warning" is not one of its values. It is the collision the field's name
    // is meant to prevent, and the TypeScript mirror has to coerce it the same way.
    assert_eq!(
        audit_settings(json!(["email"]), "warning")
            .kinds
            .audit_finding
            .min_finding_severity,
        AuditMinSeverity::Warn
    );
    assert!(AuditMinSeverity::Info.allows(bc_domain_audit::AuditSeverity::Info));
    assert!(!AuditMinSeverity::Info.allows(bc_domain_audit::AuditSeverity::Pass));
    assert!(!AuditMinSeverity::Fail.allows(bc_domain_audit::AuditSeverity::Warn));

    // The audit only runs the categories the user asked for.
    let options = audit_settings(json!(["email"]), "warn")
        .kinds
        .audit_finding
        .audit_options();
    assert!(options.include_categories.email);
    assert!(!options.include_categories.security);
    assert!(!options.include_categories.hygiene);
    assert_eq!(options.domain_expires_at, None);
}

#[test]
fn audit_state_and_inbox_written_before_the_audit_kind_still_load() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("notifications");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("state.json"),
        json!({
            "version": 1,
            "lastRecordCheckAt": "2026-02-01T00:00:00.000Z",
            "lastExpiryCheckAt": "2026-02-02T00:00:00.000Z",
            "zoneCursor": 3,
            "zones": { "z1": { "zoneName": "example.com", "snapshotRecords": 12 } },
            "expiry": { "example.com": { "expiresAt": "2026-06-01T00:00:00.000Z", "emitted": [90, 60] } },
            "held": []
        })
        .to_string(),
    )
    .unwrap();
    let stored_items: Vec<Value> = ["domain_expiry", "record_change", "service"]
        .iter()
        .map(|kind| {
            json!({
                "id": format!("id-{kind}"),
                "kind": kind,
                "severity": "warning",
                "title": "stored",
                "body": "stored",
                "createdAt": "2026-02-01T00:00:00.000Z",
                "dedupeKey": format!("key-{kind}"),
            })
        })
        .collect();
    std::fs::write(
        root.join("inbox.json"),
        json!({ "version": 1, "items": stored_items }).to_string(),
    )
    .unwrap();

    let store = NotifyStore::open(&root).expect("open store");
    assert!(
        store.recovered_errors().is_empty(),
        "{:?}",
        store.recovered_errors()
    );
    assert_eq!(store.items().len(), 3, "no stored notification is dropped");
    assert_eq!(
        store.state().last_record_check_at.as_deref(),
        Some("2026-02-01T00:00:00.000Z")
    );
    assert_eq!(store.state().zone_cursor, 3);
    assert_eq!(store.state().zones["z1"].zone_name, "example.com");
    assert_eq!(store.state().expiry["example.com"].emitted, vec![90, 60]);
    // The new state lives alongside, empty.
    assert_eq!(store.state().audit_zone_cursor, 0);
    assert!(store.state().audit.is_empty());
    assert_eq!(store.state().last_audit_check_at, None);
}

#[tokio::test]
async fn audit_notifications_obey_quiet_hours_like_every_kind() {
    let (_dir, mut store) = temp_store();
    let mut settings = email_audit_settings("fail");
    settings.quiet_hours = serde_json::from_value(json!({
        "enabled": true,
        "start": "00:00",
        "end": "23:59",
        "timezone": "UTC",
        "behaviour": "hold",
    }))
    .unwrap();
    let source = audit_source(&[("z1", "example.com")]);
    let report = run_audit_pass(&source, &mut store, &settings, now()).await;
    assert_eq!(report.notifications_created, 1);
    assert_eq!(
        store.held_count(),
        1,
        "held, not delivered, during quiet hours"
    );
    assert!(store.items().is_empty());

    settings.quiet_hours.enabled = false;
    run_audit_pass(&source, &mut store, &settings, now() + Duration::days(1)).await;
    assert_eq!(store.held_count(), 0);
    assert_eq!(store.items().len(), 1, "released once the window is over");
    assert_eq!(store.items()[0].kind, NotificationKind::AuditFinding);
}
