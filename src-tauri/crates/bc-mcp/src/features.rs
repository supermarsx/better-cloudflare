//! Host feature switches this server has to honour.
//!
//! A tool is not exempt from a feature switch because a model asked for it
//! rather than a person. `dns_check_registration` makes its own RDAP request,
//! from this crate, over a client this crate owns — so if the registry
//! monitoring switch stopped only the renderer and the notification service,
//! the app would still be contacting registries on the user's behalf whenever
//! the assistant decided to. That is the switch failing at its one promise.
//!
//! ## Why a process flag, and where it is written
//!
//! The same reasoning as `registrar_commands` in the desktop crate: the
//! renderer's browser preference is the single source of truth, because the web
//! build has no host to store anything, and this is its mirror rather than a
//! second copy with an opinion of its own. There is exactly one write site —
//! `registrar_commands::set_registry_monitoring_enabled`, the command the
//! renderer calls — which fans out to both mirrors together, so they cannot
//! come to disagree.
//!
//! It starts permitted, which is the upgrade story: a build that has never
//! heard of the switch, and the moments before the renderer's first push,
//! behave exactly as they did before it existed. Nothing here acts unprompted
//! — every reader is a tool invocation — so there is no window in which this
//! being permissive can spend a request nobody asked for.

use std::sync::atomic::{AtomicBool, Ordering};

static REGISTRY_LOOKUPS_ENABLED: AtomicBool = AtomicBool::new(true);

/// What a refused registry tool call says.
///
/// Written for a model as much as for the person reading the transcript: it
/// says the request was not made, names the switch, and says plainly that
/// retrying will not help — a refusal a model reads as transient is a refusal
/// it will spend turns on.
pub const REGISTRY_LOOKUPS_DISABLED: &str =
    "Registry monitoring is turned off in this app's settings, so no request was made to the \
     registry. This is a user preference, not a transient failure: retrying will not help, and \
     no registry data is available until it is turned back on in Settings › General.";

/// Mirror the host's registry monitoring preference into this crate.
pub fn set_registry_lookups_enabled(enabled: bool) {
    REGISTRY_LOOKUPS_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Whether a registry lookup is permitted right now.
pub fn registry_lookups_enabled() -> bool {
    REGISTRY_LOOKUPS_ENABLED.load(Ordering::Relaxed)
}

/// `Ok(())` while registry lookups are permitted, the refusal otherwise.
pub(crate) fn ensure_registry_lookups() -> Result<(), String> {
    if registry_lookups_enabled() {
        Ok(())
    } else {
        Err(REGISTRY_LOOKUPS_DISABLED.to_string())
    }
}

/// Serialises the tests that move the switch, for the reason the desktop
/// crate's equivalent does: it is process-global state and `cargo test` runs a
/// crate's tests in threads of one process, so a test that turns it off would
/// otherwise turn it off underneath whatever else was running.
#[cfg(test)]
static TEST_SWITCH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Holds the switch at `enabled` while it is alive, then puts back whatever was
/// there before.
#[cfg(test)]
pub(crate) struct RegistryLookupGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    previous: bool,
}

#[cfg(test)]
impl Drop for RegistryLookupGuard {
    fn drop(&mut self) {
        REGISTRY_LOOKUPS_ENABLED.store(self.previous, Ordering::Relaxed);
    }
}

#[cfg(test)]
pub(crate) fn registry_lookups_for_test(enabled: bool) -> RegistryLookupGuard {
    let lock = TEST_SWITCH_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let previous = registry_lookups_enabled();
    // Through the public setter, not around it: a helper that wrote the flag
    // directly would keep passing if the setter ever stopped doing so.
    set_registry_lookups_enabled(enabled);
    RegistryLookupGuard {
        _lock: lock,
        previous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lookups_are_permitted_until_something_says_otherwise() {
        let _guard = registry_lookups_for_test(true);
        assert!(registry_lookups_enabled());
        assert_eq!(ensure_registry_lookups(), Ok(()));
    }

    #[test]
    fn the_refusal_tells_a_model_not_to_retry() {
        let message = REGISTRY_LOOKUPS_DISABLED;
        assert!(message.contains("no request was made"));
        assert!(
            message.contains("retrying will not help"),
            "a model that reads this as transient will spend turns on it"
        );
        assert!(message.contains("Settings"), "and where to turn it back on");
    }
}
