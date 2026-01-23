// Prevents additional console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod crypto;
mod storage;
mod cloudflare_api;
mod passkey;
mod audit;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
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
            
            // Vault Operations
            commands::store_vault_secret,
            commands::get_vault_secret,
            commands::delete_vault_secret,
            
            // Passkey Operations
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
        ])
        .setup(|app| {
            // Initialize storage
            let app_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_dir)?;
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
