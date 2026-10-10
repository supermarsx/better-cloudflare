//! The persisted half of sync configuration.
//!
//! Lives in `Preferences::sync` as one nested, versioned object, following
//! `bc_notify::NotificationSettings`: a feature with more than a handful of
//! settings earns its own object rather than a dozen more `Option` fields on
//! a struct that is already a hundred lines long.
//!
//! **Nothing here is secret.** The provider credential and the sync
//! passphrase are in the OS keyring; see `src/lib/sync/types.ts`. What is
//! persisted is a URL, a username, a cadence and a timestamp — all of which
//! the settings screen displays anyway.

use serde::{Deserialize, Serialize};

/// Bumped only for a change an older build would read *incorrectly*.
pub const SETTINGS_VERSION: u32 = 1;

/// Bounds on the automatic push cadence.
///
/// The floor is fifteen minutes because each pass is a full seal-and-upload of
/// the whole vault, and a one-minute cadence would hammer a provider for no
/// benefit — the vault changes when someone adds a key, which is not an
/// hourly event. The ceiling is a week, past which "automatic" stops meaning
/// anything useful and the user wants manual.
pub const MIN_AUTO_PUSH_MINUTES: u32 = 15;
pub const MAX_AUTO_PUSH_MINUTES: u32 = 7 * 24 * 60;

/// The keyring slot the sync passphrase is stored under.
///
/// Shared across providers, unlike a credential: the passphrase seals the
/// payload, not the connection, so a user who switches from Nextcloud to a
/// local folder must still be able to open the blob they pushed from the other.
pub const PASSPHRASE_SLOT: &str = "passphrase";

/// Which backend a configured sync talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncProvider {
    Nextcloud,
    /// A folder on this machine, which is usually a folder some other sync
    /// client is already carrying — Google Drive for desktop, Dropbox,
    /// OneDrive, iCloud, Syncthing — or a network mount or a USB stick.
    ///
    /// This replaced a Google Drive API engine. See `folder.rs` for why the
    /// swap is an improvement rather than a retreat: no token to expire, every
    /// provider at once, and an atomic rename for a write guard.
    Folder,
}

impl SyncProvider {
    /// The keyring slot this provider's credential is stored under, or `None`
    /// for a provider that has no credential.
    ///
    /// `Folder` has none, and the `Option` is how that fact reaches every
    /// caller rather than being re-derived. A folder is reached through the
    /// filesystem, so there is nothing to authenticate with: the access check
    /// is the directory's own permissions. Returning an unused slot name
    /// instead would make `credential_present` a question with no meaning, and
    /// the screen would ask for a secret that is never read.
    ///
    /// Per-provider rather than one shared slot, so that switching provider
    /// does not silently hand a Nextcloud app password to something else — and
    /// so that switching back finds the old credential still there instead of
    /// asking for it again.
    ///
    /// This is the slot, not the full key: `bc_storage` prefixes it, the same
    /// way `store_vault_secret` prefixes `vault:`.
    pub fn credential_slot(self) -> Option<&'static str> {
        match self {
            Self::Nextcloud => Some("nextcloud"),
            Self::Folder => None,
        }
    }

    /// Whether this provider needs a credential at all.
    ///
    /// The screen reads this rather than inferring it from the absence of a
    /// slot, so "no credential is stored" and "no credential is wanted" are
    /// different states on screen instead of one ambiguous one.
    pub fn needs_credential(self) -> bool {
        self.credential_slot().is_some()
    }
}

/// Sync settings as persisted. See the module header: not secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncSettings {
    pub version: u32,
    pub enabled: bool,
    pub provider: Option<SyncProvider>,
    pub webdav_url: Option<String>,
    pub webdav_username: Option<String>,
    /// The absolute path of the configured folder. Not secret, and not a
    /// credential — it is chosen through a native picker and shown back to the
    /// user, because a sync target they cannot read back is one they cannot
    /// verify.
    pub folder_path: Option<String>,
    /// `None` for manual only, which is the default. An automatic upload of a
    /// credential store should be something the user switched on, not
    /// something they find out about.
    pub auto_push_minutes: Option<u32>,
    pub last_synced_at: Option<String>,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            enabled: false,
            provider: None,
            webdav_url: None,
            webdav_username: None,
            folder_path: None,
            auto_push_minutes: None,
            last_synced_at: None,
        }
    }
}

impl SyncSettings {
    /// Clamp and tidy every field. Never fails.
    pub fn normalize(mut self) -> Self {
        self.version = SETTINGS_VERSION;
        self.webdav_url = normalize_text(self.webdav_url);
        self.webdav_username = normalize_text(self.webdav_username);
        self.folder_path = normalize_text(self.folder_path);
        self.auto_push_minutes = self
            .auto_push_minutes
            .map(|minutes| minutes.clamp(MIN_AUTO_PUSH_MINUTES, MAX_AUTO_PUSH_MINUTES));
        // A sync with no provider is not a sync. Leaving `enabled` true with
        // nothing to talk to would make the status line claim sync is on
        // while every pass fails with `not-configured`.
        if self.provider.is_none() {
            self.enabled = false;
        }
        self
    }

    /// Parse leniently and normalize. Never fails: garbage becomes defaults,
    /// matching `NotificationSettings::from_value`. A preferences file this
    /// cannot read must not be a preferences file that stops the app.
    pub fn from_value(value: &serde_json::Value) -> Self {
        serde_json::from_value::<Self>(value.clone())
            .unwrap_or_default()
            .normalize()
    }

    /// Whether an automatic push is due, given when the last one completed.
    ///
    /// Separate from the scheduler so the rule is testable without a clock:
    /// the one thing that must not happen is a cadence that fires every tick
    /// because `last_synced_at` failed to parse.
    pub fn auto_push_due(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        if !self.enabled || self.provider.is_none() {
            return false;
        }
        let Some(minutes) = self.auto_push_minutes else {
            return false;
        };
        let Some(last) = self.last_synced_at.as_deref() else {
            // Never synced, automatic push on: the first pass is due.
            return true;
        };
        match chrono::DateTime::parse_from_rfc3339(last) {
            Ok(parsed) => {
                let elapsed = now.signed_duration_since(parsed.with_timezone(&chrono::Utc));
                elapsed >= chrono::Duration::minutes(i64::from(minutes))
            }
            // An unparseable timestamp must not mean "due on every tick".
            // Treating it as not-due costs one missed cadence and is fixed by
            // the next successful push, where the alternative is an upload
            // loop against someone's Nextcloud.
            Err(_) => false,
        }
    }
}

/// What `get_sync_status` returns: the persisted settings plus what the
/// keyring holds, which is computed per call and never stored.
///
/// Two structs rather than `#[serde(skip)]` fields on one, because a
/// `credential_present` that round-trips through the preferences file is a
/// `credential_present` that can disagree with the keyring — and the screen
/// would then say "connected" about a credential that is gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettingsView {
    #[serde(flatten)]
    pub settings: SyncSettings,
    pub credential_present: bool,
    pub passphrase_present: bool,
}

fn normalize_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Utc};

    fn at(minutes: i64) -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap() + Duration::minutes(minutes)
    }

    #[test]
    fn provider_names_are_kebab_case_on_the_wire() {
        assert_eq!(
            serde_json::to_value(SyncProvider::Folder).unwrap(),
            serde_json::json!("folder")
        );
        assert_eq!(
            serde_json::to_value(SyncProvider::Nextcloud).unwrap(),
            serde_json::json!("nextcloud")
        );
    }

    #[test]
    fn only_the_provider_that_authenticates_has_a_credential_slot() {
        // A folder is reached through the filesystem, so there is nothing to
        // authenticate with and the access check is the directory's own
        // permissions. Handing it an unused slot name would make
        // `credential_present` a question with no meaning, and the screen
        // would ask for a secret nothing ever reads.
        assert_eq!(SyncProvider::Nextcloud.credential_slot(), Some("nextcloud"));
        assert_eq!(SyncProvider::Folder.credential_slot(), None);

        assert!(SyncProvider::Nextcloud.needs_credential());
        assert!(!SyncProvider::Folder.needs_credential());
    }

    #[test]
    fn a_folder_path_is_tidied_like_the_other_text_fields() {
        let settings = SyncSettings {
            folder_path: Some("   ".into()),
            ..SyncSettings::default()
        }
        .normalize();
        assert_eq!(settings.folder_path, None, "whitespace is not a path");
    }

    #[test]
    fn enabled_without_a_provider_is_normalized_off() {
        let settings = SyncSettings {
            enabled: true,
            provider: None,
            ..SyncSettings::default()
        }
        .normalize();
        assert!(!settings.enabled);
    }

    #[test]
    fn cadence_is_clamped_both_ways() {
        let low = SyncSettings {
            auto_push_minutes: Some(1),
            ..SyncSettings::default()
        }
        .normalize();
        assert_eq!(low.auto_push_minutes, Some(MIN_AUTO_PUSH_MINUTES));

        let high = SyncSettings {
            auto_push_minutes: Some(u32::MAX),
            ..SyncSettings::default()
        }
        .normalize();
        assert_eq!(high.auto_push_minutes, Some(MAX_AUTO_PUSH_MINUTES));
    }

    #[test]
    fn blank_text_fields_become_none() {
        let settings = SyncSettings {
            webdav_url: Some("   ".into()),
            webdav_username: Some("  alice  ".into()),
            ..SyncSettings::default()
        }
        .normalize();
        assert_eq!(settings.webdav_url, None);
        assert_eq!(settings.webdav_username.as_deref(), Some("alice"));
    }

    #[test]
    fn garbage_preferences_become_defaults() {
        let settings = SyncSettings::from_value(&serde_json::json!("not an object"));
        assert_eq!(settings, SyncSettings::default());
    }

    #[test]
    fn an_unparseable_timestamp_does_not_make_every_tick_due() {
        let settings = SyncSettings {
            enabled: true,
            provider: Some(SyncProvider::Nextcloud),
            auto_push_minutes: Some(60),
            last_synced_at: Some("the day before yesterday".into()),
            ..SyncSettings::default()
        };
        assert!(
            !settings.auto_push_due(at(0)),
            "an unparseable timestamp must not schedule an upload loop"
        );
    }

    #[test]
    fn a_never_synced_device_is_due_immediately() {
        let settings = SyncSettings {
            enabled: true,
            provider: Some(SyncProvider::Nextcloud),
            auto_push_minutes: Some(60),
            last_synced_at: None,
            ..SyncSettings::default()
        };
        assert!(settings.auto_push_due(at(0)));
    }

    #[test]
    fn cadence_is_respected_and_manual_never_fires() {
        let base = SyncSettings {
            enabled: true,
            provider: Some(SyncProvider::Nextcloud),
            auto_push_minutes: Some(60),
            last_synced_at: Some(at(0).to_rfc3339()),
            ..SyncSettings::default()
        };
        assert!(!base.auto_push_due(at(59)));
        assert!(base.auto_push_due(at(60)));

        let manual = SyncSettings {
            auto_push_minutes: None,
            ..base.clone()
        };
        assert!(!manual.auto_push_due(at(10_000)));

        let disabled = SyncSettings {
            enabled: false,
            ..base
        };
        assert!(!disabled.auto_push_due(at(10_000)));
    }

    #[test]
    fn the_view_flattens_settings_beside_the_keyring_flags() {
        let view = SyncSettingsView {
            settings: SyncSettings::default(),
            credential_present: true,
            passphrase_present: false,
        };
        let json = serde_json::to_value(&view).unwrap();
        // Flattened, not nested: the renderer's `SyncSettings` is one object.
        assert_eq!(json["version"], serde_json::json!(SETTINGS_VERSION));
        assert_eq!(json["credentialPresent"], serde_json::json!(true));
        assert_eq!(json["passphrasePresent"], serde_json::json!(false));
        assert!(json.get("settings").is_none());
    }
}
