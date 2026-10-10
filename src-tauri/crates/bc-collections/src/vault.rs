//! Which collections are unlocked right now, for this session only.
//!
//! # It holds the passphrase, not a derived key
//!
//! The contract says unlocking "derives a key and holds it in the backend's
//! memory for the session". That is not implementable against `bc-crypto` as
//! it stands: [`bc_crypto::CryptoManager`]'s `encrypt` and `decrypt` take a
//! password `&str` and run PBKDF2 themselves, and there is no entry point that
//! accepts an already-derived key. So what a session can hold is the
//! passphrase, and this type holds it in a `Zeroizing<String>` with a
//! hand-written `Debug`.
//!
//! The difference is worth stating plainly rather than papering over, because
//! a derived key would be the better thing to hold: it is scoped to one
//! collection's salt, so it opens nothing else, whereas a passphrase someone
//! has also used elsewhere opens whatever else they used it on. Narrowing that
//! needs a `bc-crypto` change — a `derive_key` plus `encrypt_with_key` /
//! `decrypt_with_key` pair — which is not this crate's to make.
//!
//! What does hold either way is the rest of the contract's claim: this is
//! memory only, it is never written to disk or into the OS vault, and it does
//! not survive a restart, because nothing here is persisted and there is no
//! code path that could.
//!
//! # Nothing unverified gets in
//!
//! [`CollectionVault::unlock`] takes the [`SealedCollection`] and opens it
//! before storing anything, so "this vault holds a passphrase that does not
//! open its collection" is not a state the type can be put into by its API.
//! That matters for the rotation case: see [`CollectionVault::rotate`].

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use zeroize::Zeroizing;

use crate::{
    CollectionError, CollectionRecord, CollectionStatus, EncryptionConfig, SealedCollection,
};

/// The collections unlocked in this session.
///
/// Register one as managed state. It is not `Clone`, deliberately: a second
/// copy of this map is a second copy of every passphrase in it, and one of
/// them would be locked while the other was not.
#[derive(Default)]
pub struct CollectionVault {
    unlocked: HashMap<String, Zeroizing<String>>,
}

/// Hand-written so that a passphrase cannot reach a log line or a panic
/// message through `{:?}`. The count is the only thing worth showing; even the
/// collection ids are left out, because the useful question when reading a log
/// is how many are open, and the ids are in the records beside it.
impl std::fmt::Debug for CollectionVault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CollectionVault")
            .field("unlocked", &self.unlocked.len())
            .finish()
    }
}

impl CollectionVault {
    pub fn new() -> Self {
        Self::default()
    }

    /// Verify `passphrase` against the envelope and hold it for the session.
    ///
    /// The verification is the point: it is what makes "held" and "opens this
    /// collection" the same thing, so every later operation can use the held
    /// value without re-checking it.
    pub fn unlock(
        &mut self,
        sealed: &SealedCollection,
        passphrase: &str,
    ) -> Result<(), CollectionError> {
        sealed.verify_passphrase(passphrase)?;
        self.unlocked.insert(
            sealed.record.id.clone(),
            Zeroizing::new(passphrase.to_string()),
        );
        Ok(())
    }

    /// Drop the passphrase for one collection. Always succeeds, including for
    /// a collection that was not unlocked and for one that does not exist.
    pub fn lock(&mut self, id: &str) {
        self.unlocked.remove(id);
    }

    /// Drop every held passphrase. For app-lock, logout and idle timeout.
    pub fn lock_all(&mut self) {
        self.unlocked.clear();
    }

    /// Whether this collection's passphrase is held right now.
    pub fn is_unlocked(&self, id: &str) -> bool {
        self.unlocked.contains_key(id)
    }

    /// The held passphrase, or [`CollectionError::Locked`].
    ///
    /// This is the one accessor that hands a secret out, and it is what makes
    /// `locked` a real code rather than a decoration: a command that needs to
    /// re-seal calls this and reports the refusal verbatim.
    pub fn passphrase(&self, id: &str) -> Result<&str, CollectionError> {
        self.unlocked
            .get(id)
            .map(|held| held.as_str())
            .ok_or(CollectionError::Locked)
    }

    /// This collection's status, for the overview.
    pub fn status(&self, id: &str) -> CollectionStatus {
        CollectionStatus {
            id: id.to_string(),
            unlocked: self.is_unlocked(id),
        }
    }

    /// A status per record, in the order the records came in.
    pub fn statuses(&self, records: &[CollectionRecord]) -> Vec<CollectionStatus> {
        records
            .iter()
            .map(|record| self.status(&record.id))
            .collect()
    }

    /// Rotate a collection's passphrase and move the held one with it.
    ///
    /// Two facts change together here for the same reason the record and the
    /// envelope do: a vault left holding the old passphrase would keep
    /// reporting the collection as `unlocked` while every operation using the
    /// held value failed as `wrong-passphrase` — a lie on screen followed by
    /// an error that names the wrong cause.
    ///
    /// A collection that was **locked** stays locked. A rotation is not an
    /// unlock, and quietly opening a collection because its passphrase was
    /// changed would leave it readable to whoever is next at the keyboard.
    ///
    /// The held value is replaced only after the rotation succeeds, so a
    /// refused rotation leaves both the collection and the vault untouched.
    pub fn rotate(
        &mut self,
        sealed: &SealedCollection,
        current_passphrase: &str,
        new_passphrase: &str,
        seal_config: EncryptionConfig,
        now: DateTime<Utc>,
    ) -> Result<SealedCollection, CollectionError> {
        let rotated = sealed.rotate(current_passphrase, new_passphrase, seal_config, now)?;
        if self.is_unlocked(&rotated.record.id) {
            self.unlocked.insert(
                rotated.record.id.clone(),
                Zeroizing::new(new_passphrase.to_string()),
            );
        }
        Ok(rotated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CollectionMember;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("test timestamp must be RFC 3339")
            .with_timezone(&Utc)
    }

    fn collection() -> SealedCollection {
        SealedCollection::create(
            "col-1",
            "Work",
            "collection-pass",
            &[],
            EncryptionConfig::default(),
            at("2026-01-01T00:00:00Z"),
        )
        .expect("seals")
    }

    #[test]
    fn a_fresh_vault_holds_nothing() {
        let vault = CollectionVault::new();
        assert!(!vault.is_unlocked("col-1"));
        assert!(matches!(
            vault.passphrase("col-1"),
            Err(CollectionError::Locked)
        ));
        assert_eq!(
            vault.status("col-1"),
            CollectionStatus {
                id: "col-1".to_string(),
                unlocked: false,
            }
        );
    }

    #[test]
    fn unlocking_holds_the_passphrase_and_locking_drops_it() {
        let sealed = collection();
        let mut vault = CollectionVault::new();

        vault.unlock(&sealed, "collection-pass").expect("unlocks");
        assert!(vault.is_unlocked("col-1"));
        assert_eq!(vault.passphrase("col-1").expect("held"), "collection-pass");

        vault.lock("col-1");
        assert!(!vault.is_unlocked("col-1"));
        assert!(matches!(
            vault.passphrase("col-1"),
            Err(CollectionError::Locked)
        ));
        // Locking something that is not unlocked is not an error.
        vault.lock("col-1");
        vault.lock("never-existed");
    }

    /// The invariant the type exists to hold: a passphrase that does not open
    /// the envelope never gets in, so `is_unlocked` cannot be true for a
    /// collection the held value would fail on.
    #[test]
    fn a_wrong_passphrase_never_enters_the_vault() {
        let sealed = collection();
        let mut vault = CollectionVault::new();

        assert!(matches!(
            vault.unlock(&sealed, "not-the-passphrase"),
            Err(CollectionError::WrongPassphrase)
        ));
        assert!(!vault.is_unlocked("col-1"));

        assert!(matches!(
            vault.unlock(&sealed, ""),
            Err(CollectionError::NoPassphrase)
        ));
        assert!(!vault.is_unlocked("col-1"));
    }

    #[test]
    fn locking_everything_drops_every_passphrase() {
        let first = collection();
        let second = SealedCollection::create(
            "col-2",
            "Personal",
            "another-pass",
            &[],
            EncryptionConfig::default(),
            at("2026-01-01T00:00:00Z"),
        )
        .expect("seals");

        let mut vault = CollectionVault::new();
        vault.unlock(&first, "collection-pass").expect("unlocks");
        vault.unlock(&second, "another-pass").expect("unlocks");
        assert!(vault.is_unlocked("col-1") && vault.is_unlocked("col-2"));

        vault.lock_all();
        assert!(!vault.is_unlocked("col-1"));
        assert!(!vault.is_unlocked("col-2"));
    }

    #[test]
    fn statuses_come_back_one_per_record_in_order() {
        let first = collection();
        let mut second = first.record.clone();
        second.id = "col-2".to_string();

        let mut vault = CollectionVault::new();
        vault.unlock(&first, "collection-pass").expect("unlocks");

        let statuses = vault.statuses(&[first.record.clone(), second]);
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].id, "col-1");
        assert!(statuses[0].unlocked);
        assert_eq!(statuses[1].id, "col-2");
        assert!(!statuses[1].unlocked);
    }

    #[test]
    fn rotating_an_unlocked_collection_replaces_the_held_passphrase() {
        let sealed = collection();
        let mut vault = CollectionVault::new();
        vault.unlock(&sealed, "collection-pass").expect("unlocks");

        let rotated = vault
            .rotate(
                &sealed,
                "collection-pass",
                "a-new-passphrase",
                EncryptionConfig::default(),
                at("2026-02-02T03:04:05Z"),
            )
            .expect("rotates");

        assert!(vault.is_unlocked("col-1"));
        assert_eq!(vault.passphrase("col-1").expect("held"), "a-new-passphrase");
        // And the held value really does open the rotated envelope.
        assert!(rotated
            .verify_passphrase(vault.passphrase("col-1").expect("held"))
            .is_ok());
    }

    #[test]
    fn rotating_a_locked_collection_leaves_it_locked() {
        let sealed = collection();
        let mut vault = CollectionVault::new();

        let rotated = vault
            .rotate(
                &sealed,
                "collection-pass",
                "a-new-passphrase",
                EncryptionConfig::default(),
                at("2026-02-02T03:04:05Z"),
            )
            .expect("rotates");

        assert!(
            !vault.is_unlocked("col-1"),
            "a rotation is not an unlock: the next person at the keyboard must still type it"
        );
        assert!(rotated.verify_passphrase("a-new-passphrase").is_ok());
    }

    #[test]
    fn a_refused_rotation_leaves_the_held_passphrase_alone() {
        let sealed = collection();
        let mut vault = CollectionVault::new();
        vault.unlock(&sealed, "collection-pass").expect("unlocks");

        assert!(matches!(
            vault.rotate(
                &sealed,
                "not-the-passphrase",
                "a-new-passphrase",
                EncryptionConfig::default(),
                at("2026-02-02T03:04:05Z"),
            ),
            Err(CollectionError::WrongPassphrase)
        ));
        assert_eq!(vault.passphrase("col-1").expect("held"), "collection-pass");
    }

    #[test]
    fn a_vault_debug_line_holds_no_passphrase() {
        let sealed = collection();
        let mut vault = CollectionVault::new();
        vault.unlock(&sealed, "collection-pass").expect("unlocks");

        let rendered = format!("{vault:?}");
        assert!(!rendered.contains("collection-pass"), "{rendered}");
        assert!(
            rendered.contains("unlocked: 1"),
            "the count is worth showing: {rendered}"
        );
    }

    /// A member added through a held passphrase, end to end — the shape the
    /// command layer will use, so that `passphrase()` handing out a `&str` is
    /// exercised rather than assumed to compose.
    #[test]
    fn a_held_passphrase_drives_a_membership_change() {
        let sealed = collection();
        let mut vault = CollectionVault::new();
        vault.unlock(&sealed, "collection-pass").expect("unlocks");

        let after = sealed
            .add_member(
                vault.passphrase("col-1").expect("held"),
                CollectionMember::new("key-1", "cf-token-1"),
                None,
                EncryptionConfig::default(),
                at("2026-02-02T03:04:05Z"),
            )
            .expect("adds");
        assert_eq!(after.record.member_ids, vec!["key-1".to_string()]);
    }
}
