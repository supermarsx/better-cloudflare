//! Unit tests for bc-notify (no network; temp directories only).

use std::collections::{HashMap, HashSet};
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
use crate::model::{Notification, NotificationKind, NotificationQuery, Scope, Severity};
use crate::rdap::is_valid_hostname;
use crate::settings::{
    ExpirySource, MinSeverity, NotificationSettings, SeverityMode, ZoneMode, ZoneOverride,
};
use crate::store::NotifyStore;
use crate::{
    deliver, evaluate_expiry_milestones, record_expiry, run_expiry_pass_with, run_record_pass,
    PassKind, PassReport, RdapClient, ZoneRef, ZoneSource,
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
