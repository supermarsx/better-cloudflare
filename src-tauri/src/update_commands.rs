//! Tauri command for the check-only update notifier.
//!
//! All the logic — the bounded request, the projection, the `YY.N`
//! comparison — lives in `bc-update`, which knows nothing about Tauri and is
//! tested without a socket. This file is only the IPC edge.

use bc_update::UpdateCheck;

/// Ask GitHub whether a release newer than this build exists.
///
/// Check only: this reports what it found and never downloads or installs
/// anything. The project's release assets are unsigned, so there is no
/// signature an updater could verify, and a self-replacing binary without one
/// is not something this app will do.
///
/// Takes no credential and no state: the releases list is public and the
/// request is unauthenticated. Errors — including GitHub rate-limiting an
/// unauthenticated caller — come back as a message for the UI to show; nothing
/// retries on its own.
#[tauri::command]
pub async fn update_check(include_prereleases: bool) -> Result<UpdateCheck, String> {
    bc_update::check_for_update(bc_update::shared_client(), include_prereleases)
        .await
        .map_err(|error| error.to_string())
}
