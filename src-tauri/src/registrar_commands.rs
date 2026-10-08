//! Tauri commands for the registrar monitoring feature.
//!
//! Delegates provider client construction to [`bc_registrar::build_client`]
//! and health-check logic to [`bc_registrar::compute_health_check`].
//!
//! This module also owns the host side of the **registry monitoring feature
//! switch** — see [`registry_monitoring_enabled`] — because this is where the
//! outbound registrar traffic is made, and a gate belongs next to the thing it
//! gates rather than one layer up from it.

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Utc;
use tauri::State;

use crate::storage::Storage;
use bc_registrar::{
    compute_health_check, DomainHealthCheck, DomainInfo, RegistrarClient, RegistrarCredential,
    RegistrarProvider,
};

// ─── The registry monitoring feature switch ────────────────────────────────

/// Whether this process may contact a domain registry or a registrar.
///
/// `true` until told otherwise, which is the whole upgrade story: a build that
/// has never heard of the switch, and a renderer whose push has not landed yet,
/// both behave exactly as they did before it existed.
///
/// **Why a process flag and not a stored preference.** The switch has to work
/// on the web build too, where there is no host to store anything, so the
/// renderer's browser preference is the single source of truth and this is its
/// mirror rather than a second copy with its own opinion. That leaves one
/// question — can a registry request happen before the renderer has pushed? —
/// and the answer is no for the only caller that acts unprompted: the
/// background notification service is started by `notifications_start`, which
/// the renderer calls, and the renderer pushes this first. Every other reader
/// here is a command, so it cannot run before a renderer exists to call it.
static REGISTRY_MONITORING_ENABLED: AtomicBool = AtomicBool::new(true);

/// What a refused registry call says. A whole sentence, naming the switch:
/// these strings reach a toast unchanged, and "forbidden" would leave the user
/// hunting for something they themselves turned off.
pub const REGISTRY_MONITORING_DISABLED: &str =
    "Registry monitoring is turned off in settings, so no request was made to the registry or registrar. Turn it back on in Settings › General to use this.";

/// Whether registry and registrar traffic is permitted right now.
///
/// Read by [`crate::notifications`] as well, which is why it is public: the
/// background expiry pass spends exactly the same kind of request from a timer
/// instead of a click, and one switch has to cover both or it is not a switch.
pub fn registry_monitoring_enabled() -> bool {
    REGISTRY_MONITORING_ENABLED.load(Ordering::Relaxed)
}

/// `Ok(())` while registry traffic is allowed, the refusal sentence otherwise.
///
/// Public because the registry is reached from more than this module: the
/// audit's `lookup_domain_registry` goes straight to RDAP from
/// `crate::commands::dns`, without a registrar client to pass through. One
/// predicate for both, so the two cannot come to disagree about what "off"
/// means.
pub fn ensure_registry_monitoring() -> Result<(), String> {
    if registry_monitoring_enabled() {
        Ok(())
    } else {
        Err(REGISTRY_MONITORING_DISABLED.to_string())
    }
}

/// Mirror the renderer's registry-monitoring preference into this process.
///
/// Called whenever the preference is read or changed, and before the renderer
/// starts the background service. Needs no reply: the renderer already knows
/// what it set, and a command that cannot fail has nothing to report.
///
/// **The one write site, deliberately.** There are two mirrors of this
/// preference in the process — this flag, which gates the registrar commands
/// and the background expiry pass, and `bc_mcp::features`, which gates the
/// `dns_check_registration` tool the assistant can call. Both are set here, in
/// one statement each, so they cannot come to disagree: a second entry point
/// that set only one of them would leave "nothing leaves for a registry" true
/// of the user's own clicks and false of the model's.
#[tauri::command]
pub fn set_registry_monitoring_enabled(enabled: bool) {
    REGISTRY_MONITORING_ENABLED.store(enabled, Ordering::Relaxed);
    bc_mcp::set_registry_lookups_enabled(enabled);
}

/// Serialises the tests that move the switch. It is process-global state, and
/// `cargo test` runs this crate's tests in threads of one process, so without
/// this a test that turns registry monitoring off would turn it off underneath
/// whatever else happened to be running.
#[cfg(test)]
static TEST_SWITCH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Holds the switch at `enabled` for as long as it is alive, then puts back
/// whatever was there before.
///
/// Anything that reads the switch has to hold one of these, not just the tests
/// that move it: a test reading the default while another holds it off would
/// otherwise see the other test's value. That is why the notification
/// harness takes one unconditionally, and why moving the switch mid-test goes
/// through [`RegistryMonitoringGuard::set`] rather than through a second
/// acquisition, which would deadlock on the same mutex.
#[cfg(test)]
pub(crate) struct RegistryMonitoringGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    previous: bool,
}

#[cfg(test)]
impl RegistryMonitoringGuard {
    /// Move the switch while this guard holds the lock.
    pub(crate) fn set(&self, enabled: bool) {
        set_registry_monitoring_enabled(enabled);
    }
}

#[cfg(test)]
impl Drop for RegistryMonitoringGuard {
    fn drop(&mut self) {
        REGISTRY_MONITORING_ENABLED.store(self.previous, Ordering::Relaxed);
    }
}

#[cfg(test)]
pub(crate) fn registry_monitoring_for_test(enabled: bool) -> RegistryMonitoringGuard {
    let lock = TEST_SWITCH_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let previous = registry_monitoring_enabled();
    // Through the command itself, not around it: a helper that wrote the flag
    // directly would keep passing if the command ever stopped doing so.
    set_registry_monitoring_enabled(enabled);
    RegistryMonitoringGuard {
        _lock: lock,
        previous,
    }
}

/// Build the appropriate registrar client from a credential ID.
///
/// The feature gate lives here rather than only in each command, so a command
/// added later cannot forget it: every outbound registrar call in this module
/// goes through a client, and this is the only place one is built.
async fn build_client_from_id(
    storage: &Storage,
    credential_id: &str,
) -> Result<Box<dyn RegistrarClient>, String> {
    ensure_registry_monitoring()?;
    let cred: RegistrarCredential = storage
        .get_registrar_credential(credential_id)
        .await
        .map_err(|e| e.to_string())?;
    let secrets = storage
        .get_registrar_secrets(credential_id)
        .await
        .map_err(|e| e.to_string())?;
    bc_registrar::build_client(&cred, &secrets)
}

// ─── Credential management ─────────────────────────────────────────────────

// Tauri derives these top-level argument names from the command signature.
// Grouping them would break the established `add_registrar_credential` IPC payload.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn add_registrar_credential(
    storage: State<'_, Storage>,
    provider: RegistrarProvider,
    label: String,
    username: Option<String>,
    email: Option<String>,
    api_key: String,
    api_secret: Option<String>,
    extra: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    let id = format!("reg_{}", uuid::Uuid::new_v4());
    let cred = RegistrarCredential {
        id: id.clone(),
        provider,
        label: label.clone(),
        username,
        email,
        created_at: Utc::now().to_rfc3339(),
    };
    storage
        .store_registrar_credential(&cred)
        .await
        .map_err(|e| e.to_string())?;

    let mut secrets = std::collections::HashMap::new();
    secrets.insert("api_key".to_string(), api_key);
    if let Some(secret) = api_secret {
        secrets.insert("api_secret".to_string(), secret);
    }
    if let Some(extra) = extra {
        secrets.extend(extra);
    }
    storage
        .store_registrar_secrets(&id, &secrets)
        .await
        .map_err(|e| e.to_string())?;

    let _ = storage
        .add_audit_entry(serde_json::json!({
            "timestamp": Utc::now().to_rfc3339(),
            "operation": "registrar:add_credential",
            "resource": id,
            "label": label,
        }))
        .await;

    Ok(id)
}

#[tauri::command]
pub async fn list_registrar_credentials(
    storage: State<'_, Storage>,
) -> Result<Vec<RegistrarCredential>, String> {
    storage
        .get_registrar_credentials()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_registrar_credential(
    storage: State<'_, Storage>,
    credential_id: String,
) -> Result<(), String> {
    storage
        .delete_registrar_secrets(&credential_id)
        .await
        .map_err(|e| e.to_string())?;
    storage
        .delete_registrar_credential(&credential_id)
        .await
        .map_err(|e| e.to_string())?;

    let _ = storage
        .add_audit_entry(serde_json::json!({
            "timestamp": Utc::now().to_rfc3339(),
            "operation": "registrar:delete_credential",
            "resource": credential_id,
        }))
        .await;

    Ok(())
}

#[tauri::command]
pub async fn verify_registrar_credential(
    storage: State<'_, Storage>,
    credential_id: String,
) -> Result<bool, String> {
    let client = build_client_from_id(&storage, &credential_id).await?;
    client.verify_credentials().await
}

// ─── Domain operations ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn registrar_list_domains(
    storage: State<'_, Storage>,
    credential_id: String,
) -> Result<Vec<DomainInfo>, String> {
    let client = build_client_from_id(&storage, &credential_id).await?;
    let domains = client.list_domains().await?;

    let _ = storage
        .add_audit_entry(serde_json::json!({
            "timestamp": Utc::now().to_rfc3339(),
            "operation": "registrar:list_domains",
            "resource": credential_id,
            "count": domains.len(),
        }))
        .await;

    Ok(domains)
}

#[tauri::command]
pub async fn registrar_get_domain(
    storage: State<'_, Storage>,
    credential_id: String,
    domain: String,
) -> Result<DomainInfo, String> {
    let client = build_client_from_id(&storage, &credential_id).await?;
    client.get_domain(&domain).await
}

#[tauri::command]
pub async fn registrar_list_all_domains(
    storage: State<'_, Storage>,
) -> Result<Vec<DomainInfo>, String> {
    // Checked here as well as in `build_client_from_id`, because this command
    // logs and discards a client-build failure per credential. Without its own
    // check a disabled feature would answer "no domains" — a wrong answer
    // wearing a success — instead of saying it did not look.
    ensure_registry_monitoring()?;
    let creds: Vec<RegistrarCredential> = storage
        .get_registrar_credentials()
        .await
        .map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    for cred in &creds {
        match build_client_from_id(&storage, &cred.id).await {
            Ok(client) => match client.list_domains().await {
                Ok(domains) => all.extend(domains),
                Err(e) => eprintln!("Error listing domains for {}: {}", cred.label, e),
            },
            Err(e) => eprintln!("Error building client for {}: {}", cred.label, e),
        }
    }
    Ok(all)
}

// ─── Health checks ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn registrar_health_check(
    storage: State<'_, Storage>,
    credential_id: String,
    domain: String,
) -> Result<DomainHealthCheck, String> {
    let client = build_client_from_id(&storage, &credential_id).await?;
    let info = client.get_domain(&domain).await?;
    let health = compute_health_check(&info);

    let _ = storage
        .add_audit_entry(serde_json::json!({
            "timestamp": Utc::now().to_rfc3339(),
            "operation": "registrar:health_check",
            "resource": domain,
            "status": format!("{:?}", health.status),
        }))
        .await;

    Ok(health)
}

#[tauri::command]
pub async fn registrar_health_check_all(
    storage: State<'_, Storage>,
) -> Result<Vec<DomainHealthCheck>, String> {
    // Same reason as `registrar_list_all_domains`: this one swallows every
    // failure, so an empty `Ok` would read as "every domain is fine".
    ensure_registry_monitoring()?;
    let creds: Vec<RegistrarCredential> = storage
        .get_registrar_credentials()
        .await
        .map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for cred in &creds {
        if let Ok(client) = build_client_from_id(&storage, &cred.id).await {
            if let Ok(domains) = client.list_domains().await {
                for d in &domains {
                    results.push(compute_health_check(d));
                }
            }
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Absent means on. The flag starts `true` so a build that has never been
    /// told about the switch, and the moments before the renderer's first push,
    /// behave exactly as they did before the switch existed.
    #[test]
    fn registry_monitoring_is_on_until_something_turns_it_off() {
        let _guard = registry_monitoring_for_test(true);
        assert!(registry_monitoring_enabled());
        assert_eq!(ensure_registry_monitoring(), Ok(()));
    }

    /// Every outbound call in this module goes through `build_client_from_id`,
    /// so that is where the claim has to be checked rather than on the helper
    /// it calls: with the switch off the refusal has to come out *before* the
    /// credential is looked up, which is what "no request was made" means.
    ///
    /// The two halves are what make it a measurement. With the switch on, the
    /// very same call fails for a different reason — the credential does not
    /// exist — which proves the first refusal came from the gate and not from
    /// the store.
    #[tokio::test]
    async fn a_disabled_feature_refuses_before_a_client_is_built() {
        let storage = Storage::new(false);

        // `.err()` rather than `expect_err`: `Box<dyn RegistrarClient>` has no
        // `Debug`, so the `Ok` side cannot be formatted into a panic message.
        let refused = {
            let _guard = registry_monitoring_for_test(false);
            build_client_from_id(&storage, "reg_absent")
                .await
                .err()
                .expect("a disabled feature must not build a client")
        };
        assert_eq!(refused, REGISTRY_MONITORING_DISABLED);

        let _guard = registry_monitoring_for_test(true);
        let reached_the_store = build_client_from_id(&storage, "reg_absent")
            .await
            .err()
            .expect("there is no such credential");
        assert_ne!(
            reached_the_store, REGISTRY_MONITORING_DISABLED,
            "with the switch on, the call has to get past the gate and fail on the store"
        );
    }

    /// The two mirrors move together.
    ///
    /// `bc_mcp` gates the `dns_check_registration` tool the assistant can call,
    /// and it keeps its own flag because that request is made from that crate,
    /// over a client that crate owns. A switch that set only one of them would
    /// be true of the user's clicks and false of the model's, which is the one
    /// way this feature can be off and still be contacting registries.
    #[test]
    fn the_switch_carries_to_the_mcp_tool_gate_as_well() {
        {
            let _guard = registry_monitoring_for_test(false);
            assert!(!registry_monitoring_enabled());
            assert!(
                !bc_mcp::registry_lookups_enabled(),
                "the MCP registry tool must be gated by the same switch"
            );
        }

        let _guard = registry_monitoring_for_test(true);
        assert!(registry_monitoring_enabled());
        assert!(bc_mcp::registry_lookups_enabled());
    }

    /// Politely, and in a sentence that names the switch and where to find it.
    /// These strings reach a toast unchanged; "forbidden" would leave the user
    /// hunting for something they turned off themselves.
    #[test]
    fn the_refusal_says_what_was_not_done_and_where_to_undo_it() {
        let message = REGISTRY_MONITORING_DISABLED;
        assert!(message.contains("Registry monitoring is turned off"));
        assert!(
            message.contains("no request was made"),
            "the refusal has to say that nothing left, which is the whole claim"
        );
        assert!(message.contains("Settings"), "and where to turn it back on");
        assert!(message.ends_with('.'));
    }
}
