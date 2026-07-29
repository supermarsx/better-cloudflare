// Prevents additional console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai_commands;
mod cloudflare_api;
mod commands;
mod crypto;
mod mcp_server;
mod passkey;
mod registrar_commands;
mod session;
mod storage;

use crate::mcp_server::McpServerManager;
use crate::passkey::PasskeyManager;
use crate::session::SessionManager;
use crate::storage::Storage;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

use bc_ai_agent::AgentManager;

const CRASH_LOG_DIRECTORY: &str = "better-cloudflare";
const CRASH_LOG_FILE: &str = "crash.log";

#[derive(Debug, Eq, PartialEq)]
struct CrashRecord {
    timestamp_unix: u64,
    category: &'static str,
    location: String,
}

impl CrashRecord {
    fn encode(&self) -> String {
        format!(
            "timestamp_unix={} category={} location={}\n",
            self.timestamp_unix, self.category, self.location
        )
    }
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn sanitize_category(category: &str) -> &'static str {
    match category {
        "panic" => "runtime-panic",
        "tauri-run-error" => "application-run-error",
        _ => "runtime-failure",
    }
}

fn sanitize_location(line: Option<u32>, column: Option<u32>) -> String {
    match (line, column) {
        (Some(line), Some(column)) => format!("source:{line}:{column}"),
        (Some(line), None) => format!("source:{line}"),
        _ => "source:unknown".to_string(),
    }
}

fn build_crash_record(
    timestamp_unix: u64,
    category: &str,
    line: Option<u32>,
    column: Option<u32>,
    _untrusted_payload: Option<&str>,
) -> CrashRecord {
    CrashRecord {
        timestamp_unix,
        category: sanitize_category(category),
        location: sanitize_location(line, column),
    }
}

fn crash_log_path() -> PathBuf {
    std::env::temp_dir()
        .join(CRASH_LOG_DIRECTORY)
        .join(CRASH_LOG_FILE)
}

fn write_crash_record(writer: &mut impl Write, record: &CrashRecord) -> io::Result<()> {
    writer.write_all(record.encode().as_bytes())?;
    writer.flush()
}

fn persist_crash_record(path: &Path, record: &CrashRecord) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    write_crash_record(&mut file, record)
}

fn write_stderr(message: &str) {
    let mut stderr = io::stderr().lock();
    let _ = stderr.write_all(message.as_bytes());
    let _ = stderr.flush();
}

fn report_top_level_failure_at(path: PathBuf, record: CrashRecord) -> PathBuf {
    let persisted = persist_crash_record(&path, &record).is_ok();
    let status = if persisted {
        "A minimal redacted crash record was written to"
    } else {
        "The redacted crash record could not be written; attempted location"
    };

    write_stderr(&format!(
        "Better Cloudflare encountered {}. {}: {}\n",
        record.category,
        status,
        path.display()
    ));

    path
}

fn report_top_level_failure(record: CrashRecord) -> PathBuf {
    report_top_level_failure_at(crash_log_path(), record)
}

fn install_panic_hook() {
    // An unknown prior hook may print the raw panic payload, including secrets.
    // Replace it with the minimal reporter instead of invoking it.
    let _previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|panic_info| {
        let location = panic_info.location();
        let record = build_crash_record(
            unix_timestamp(),
            "panic",
            location.map(|value| value.line()),
            location.map(|value| value.column()),
            None,
        );
        let _ = report_top_level_failure(record);
    }));
}

fn main() {
    install_panic_hook();

    let run_result = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Storage::default())
        .manage(PasskeyManager::default())
        .manage(McpServerManager::default())
        .manage(SessionManager::default())
        .manage(AgentManager::default())
        .invoke_handler(tauri::generate_handler![
            // App lifecycle
            commands::restart_app,
            commands::open_path_in_file_manager,
            // Authentication & Key Management
            commands::verify_token,
            commands::get_api_keys,
            commands::add_api_key,
            commands::update_api_key,
            commands::delete_api_key,
            commands::decrypt_api_key,
            // DNS Operations
            commands::get_zones,
            commands::get_dns_records,
            commands::create_dns_record,
            commands::update_dns_record,
            commands::delete_dns_record,
            commands::create_bulk_dns_records,
            commands::export_dns_records,
            commands::purge_cache,
            commands::get_zone_setting,
            commands::update_zone_setting,
            commands::get_dnssec,
            commands::update_dnssec,
            // Vault Operations
            commands::store_vault_secret,
            commands::get_vault_secret,
            commands::delete_vault_secret,
            // Passkey Operations
            commands::get_passkey_status,
            commands::get_passkey_registration_options,
            commands::register_passkey,
            commands::get_passkey_auth_options,
            commands::authenticate_passkey,
            commands::list_passkeys,
            commands::delete_passkey,
            // Encryption Settings
            commands::get_encryption_settings,
            commands::update_encryption_settings,
            commands::benchmark_encryption,
            // Audit
            commands::get_audit_entries,
            commands::export_audit_entries,
            commands::save_audit_entries,
            commands::save_topology_asset,
            commands::clear_audit_entries,
            commands::get_preferences,
            commands::update_preferences,
            // SPF
            commands::simulate_spf,
            commands::spf_graph,
            commands::resolve_topology_batch,
            // Registrar Monitoring
            registrar_commands::add_registrar_credential,
            registrar_commands::list_registrar_credentials,
            registrar_commands::delete_registrar_credential,
            registrar_commands::verify_registrar_credential,
            registrar_commands::registrar_list_domains,
            registrar_commands::registrar_get_domain,
            registrar_commands::registrar_list_all_domains,
            registrar_commands::registrar_health_check,
            registrar_commands::registrar_health_check_all,
            // MCP Server Management
            mcp_server::mcp_get_server_status,
            mcp_server::mcp_start_server,
            mcp_server::mcp_stop_server,
            mcp_server::mcp_set_enabled_tools,
            // DNS Tools
            commands::parse_csv_records,
            commands::parse_bind_zone,
            commands::validate_dns_record,
            commands::parse_srv,
            commands::compose_srv,
            commands::parse_tlsa,
            commands::compose_tlsa,
            commands::parse_sshfp,
            commands::compose_sshfp,
            commands::parse_naptr,
            commands::compose_naptr,
            commands::records_to_csv,
            commands::records_to_bind,
            commands::records_to_json,
            commands::parse_spf,
            // Domain Audit
            commands::run_domain_audit,
            // Biometric Authentication
            commands::biometric_status,
            commands::biometric_authenticate,
            commands::biometric_store_secret,
            commands::biometric_get_secret,
            commands::biometric_delete_secret,
            commands::biometric_has_secret,
            // Analytics
            commands::get_zone_analytics,
            commands::get_dns_analytics,
            // Firewall / WAF
            commands::get_firewall_rules,
            commands::create_firewall_rule,
            commands::update_firewall_rule,
            commands::delete_firewall_rule,
            commands::get_ip_access_rules,
            commands::create_ip_access_rule,
            commands::delete_ip_access_rule,
            commands::get_waf_rulesets,
            // Workers
            commands::get_worker_routes,
            commands::create_worker_route,
            commands::delete_worker_route,
            // Email Routing
            commands::get_email_routing_settings,
            commands::get_email_routing_rules,
            commands::create_email_routing_rule,
            commands::delete_email_routing_rule,
            // Page Rules
            commands::get_page_rules,
            // Bulk Operations
            commands::delete_bulk_dns_records,
            // DNS Propagation
            commands::check_dns_propagation,
            // Session Management
            commands::session_login,
            commands::session_logout,
            commands::session_status,
            commands::session_touch,
            commands::session_set_idle_timeout,
            // AI Assistant
            ai_commands::ai_list_providers,
            ai_commands::ai_configure_provider,
            ai_commands::ai_test_provider,
            ai_commands::ai_list_models,
            ai_commands::ai_get_config,
            ai_commands::ai_set_config,
            ai_commands::ai_create_conversation,
            ai_commands::ai_list_conversations,
            ai_commands::ai_get_conversation,
            ai_commands::ai_delete_conversation,
            ai_commands::ai_set_conversation_title,
            ai_commands::ai_send_message,
            ai_commands::ai_approve_tool_call,
            ai_commands::ai_cancel_generation,
            ai_commands::ai_list_presets,
            ai_commands::ai_get_preset,
            ai_commands::ai_export_conversation,
        ])
        .setup(|app| {
            // Initialize storage
            let app_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_dir)?;

            Ok(())
        })
        .run(tauri::generate_context!());

    if run_result.is_err() {
        let record = build_crash_record(unix_timestamp(), "tauri-run-error", None, None, None);
        let path = report_top_level_failure(record);
        write_stderr(&format!(
            "The application will now exit. Restart it and inspect the redacted log at: {}\n",
            path.display()
        ));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod crash_reporting_tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("simulated write failure"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::other("simulated flush failure"))
        }
    }

    #[test]
    fn crash_record_omits_untrusted_secret_material() {
        let sensitive_payloads = [
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature",
            "api_key=cloudflare-api-secret",
            "jwt=eyJhbGciOiJSUzI1NiJ9.private.signature",
            "password=correct-horse-battery-staple",
        ];

        for payload in sensitive_payloads {
            let record =
                build_crash_record(1_753_747_200, payload, Some(42), Some(7), Some(payload));
            let encoded = record.encode();

            assert_eq!(record.category, "runtime-failure");
            assert_eq!(record.location, "source:42:7");
            assert!(!encoded.contains(payload));
            assert!(!encoded.contains("cloudflare-api-secret"));
            assert!(!encoded.contains("correct-horse-battery-staple"));
            assert!(!encoded.contains("eyJhbGci"));
            assert!(!encoded.to_ascii_lowercase().contains("authorization"));
            assert!(!encoded.to_ascii_lowercase().contains("api_key"));
            assert!(!encoded.to_ascii_lowercase().contains("jwt"));
            assert!(!encoded.to_ascii_lowercase().contains("password"));
            assert!(!encoded.to_ascii_lowercase().contains("bearer"));
        }
    }

    #[test]
    fn crash_record_contains_only_minimal_safe_fields() {
        let record = build_crash_record(
            1_753_747_200,
            "panic",
            Some(174),
            Some(9),
            Some("raw panic payload must never be recorded"),
        );

        assert_eq!(
            record.encode(),
            "timestamp_unix=1753747200 category=runtime-panic location=source:174:9\n"
        );
    }

    #[test]
    fn writer_failure_is_returned_without_panicking() {
        let record = build_crash_record(1, "panic", None, None, Some("secret"));
        let mut writer = FailingWriter;

        let outcome = catch_unwind(AssertUnwindSafe(|| {
            write_crash_record(&mut writer, &record)
        }));

        assert!(outcome.is_ok());
        assert!(outcome.expect("write attempt should not panic").is_err());
    }

    #[test]
    fn reporter_survives_persistence_failure() {
        let blocker = std::env::temp_dir().join(format!(
            "better-cloudflare-crash-test-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        fs::write(&blocker, b"not a directory").expect("test blocker should be created");
        let impossible_path = blocker.join(CRASH_LOG_FILE);
        let record = build_crash_record(1, "panic", None, None, Some("secret"));

        let outcome = catch_unwind(AssertUnwindSafe(|| {
            report_top_level_failure_at(impossible_path.clone(), record)
        }));

        let _ = fs::remove_file(&blocker);
        assert!(outcome.is_ok());
        assert_eq!(outcome.expect("reporter should not panic"), impossible_path);
    }
}
