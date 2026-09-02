//! Pending-ceremony state: the server half of a WebAuthn challenge.
//!
//! # Why this lives in the process and not in storage
//!
//! There is one process, one window, one user, and `main.rs` manages exactly
//! one [`crate::PasskeyManager`]. **The desktop process *is* the relying-party
//! server.** Persisting ceremony state to the OS keyring would be slow, would
//! leave credential-adjacent residue in the user's Credential Manager or
//! Keychain, and would make a pending ceremony survive a restart — which is
//! precisely what it must *not* do.
//!
//! The flaw in the implementation `d05fe59` removed was not that its challenge
//! map was in-process. It was that the map had no expiry, no single-use
//! enforcement, and — fatally — that nothing cryptographic ever consumed the
//! challenge, so it was compared against a value the same caller supplied. The
//! fix is the three rules below, not a different storage medium.
//!
//! Note also that `webauthn-rs`'s `danger-allow-state-serialisation` feature is
//! deliberately off. With it off, `PasskeyRegistration` and
//! `PasskeyAuthentication` cannot be serialised at all, so the type system —
//! not a review comment — prevents anyone from handing ceremony state back to
//! the frontend, which is the replay vector upstream warns about.
//!
//! # The three rules
//!
//! 1. **Single use.** [`CeremonyStore::take`] removes the entry before the
//!    caller verifies anything, so a *failed* verification burns the challenge
//!    too. A challenge that survives a failed attempt is a retry oracle.
//! 2. **Expiry.** [`CEREMONY_TTL`] is enforced on read and swept on every
//!    insert, so an app left open does not accumulate live challenges.
//! 3. **Capacity.** At most [`MAX_PENDING_CEREMONIES`] accounts may have a
//!    ceremony in flight, so a caller looping on `get_auth_options` cannot grow
//!    memory without bound. Replacing an account's own pending ceremony is
//!    always allowed — a user who cancels and retries must not be locked out,
//!    and must not accumulate challenges either.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::PasskeyError;

/// How long a started ceremony stays completable.
///
/// Long enough for a biometric prompt and one fumbled retry, short enough to be
/// uninteresting to an attacker who has to be inside the process anyway.
pub const CEREMONY_TTL: Duration = Duration::from_secs(120);

/// How many accounts may have a ceremony in flight at once.
pub const MAX_PENDING_CEREMONIES: usize = 32;

struct Pending<S> {
    state: S,
    expires_at: Instant,
}

/// One account's in-flight ceremonies of a single kind.
///
/// Keyed by account id, so at most one live ceremony exists per account and
/// starting a new one replaces any pending one.
pub struct CeremonyStore<S> {
    entries: Mutex<HashMap<String, Pending<S>>>,
}

impl<S> Default for CeremonyStore<S> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<S> CeremonyStore<S> {
    /// Take the lock, recovering from poisoning rather than panicking.
    ///
    /// The release profile sets `panic = "abort"`, so `unwrap()` on a poisoned
    /// lock in a Tauri command path would kill the whole application over a
    /// passkey ceremony. The critical sections here do no I/O, never await, and
    /// only insert into or remove from a `HashMap`, so a poisoned map is still
    /// a structurally valid one; the worst case is a stale entry, which expiry
    /// removes.
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pending<S>>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Store `state` for `account_id`, replacing any ceremony already pending
    /// for that account.
    ///
    /// Sweeps expired entries first, so the capacity check counts live
    /// ceremonies rather than abandoned ones.
    pub fn insert(&self, account_id: &str, state: S) -> Result<(), PasskeyError> {
        let now = Instant::now();
        let mut entries = self.entries();
        entries.retain(|_, pending| pending.expires_at > now);

        // Replacing this account's own entry is not growth, so it is exempt
        // from the cap: otherwise a user whose account happened to be the 33rd
        // could never retry a cancelled ceremony.
        if !entries.contains_key(account_id) && entries.len() >= MAX_PENDING_CEREMONIES {
            return Err(PasskeyError::TooManyPendingCeremonies);
        }

        entries.insert(
            account_id.to_string(),
            Pending {
                state,
                expires_at: now + CEREMONY_TTL,
            },
        );
        Ok(())
    }

    /// Remove and return the pending ceremony for `account_id`.
    ///
    /// This is the single-use enforcement point, and it is deliberately a
    /// *take*: the entry is gone whether or not the verification that follows
    /// succeeds. An expired entry is removed and reported as expired, which is
    /// the same answer the caller gets for one that was never started — there
    /// is nothing useful to distinguish.
    pub fn take(&self, account_id: &str) -> Result<S, PasskeyError> {
        let pending = self
            .entries()
            .remove(account_id)
            .ok_or(PasskeyError::ChallengeExpired)?;
        if pending.expires_at <= Instant::now() {
            return Err(PasskeyError::ChallengeExpired);
        }
        Ok(pending.state)
    }

    /// How many ceremonies are currently stored, expired ones included. Test
    /// and diagnostic use only; nothing decides on it.
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.entries().len()
    }

    /// Force the entry for `account_id` to be expired, for tests that must not
    /// sleep for two minutes.
    #[cfg(test)]
    pub fn expire_now(&self, account_id: &str) {
        if let Some(pending) = self.entries().get_mut(account_id) {
            pending.expires_at = Instant::now() - Duration::from_secs(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_taken_ceremony_cannot_be_taken_again() {
        let store: CeremonyStore<u8> = CeremonyStore::default();
        store.insert("key_a", 7).expect("insert");

        assert_eq!(store.take("key_a").expect("first take"), 7);
        assert_eq!(
            store.take("key_a").expect_err("second take"),
            PasskeyError::ChallengeExpired
        );
    }

    #[test]
    fn starting_a_second_ceremony_replaces_the_first() {
        let store: CeremonyStore<u8> = CeremonyStore::default();
        store.insert("key_a", 1).expect("first");
        store.insert("key_a", 2).expect("second");

        assert_eq!(
            store.pending_count(),
            1,
            "a retry must not accumulate challenges"
        );
        assert_eq!(store.take("key_a").expect("take"), 2);
    }

    #[test]
    fn an_expired_ceremony_is_refused_and_removed() {
        let store: CeremonyStore<u8> = CeremonyStore::default();
        store.insert("key_a", 1).expect("insert");
        store.expire_now("key_a");

        assert_eq!(
            store.take("key_a").expect_err("expired"),
            PasskeyError::ChallengeExpired
        );
        assert_eq!(
            store.pending_count(),
            0,
            "an expired entry must not be left behind"
        );
    }

    #[test]
    fn pending_ceremonies_are_capped_but_a_retry_is_always_allowed() {
        let store: CeremonyStore<u8> = CeremonyStore::default();
        for index in 0..MAX_PENDING_CEREMONIES {
            store.insert(&format!("key_{index}"), 0).expect("insert");
        }

        assert_eq!(
            store.insert("key_overflow", 0).expect_err("cap"),
            PasskeyError::TooManyPendingCeremonies
        );
        store
            .insert("key_0", 1)
            .expect("replacing an existing account's ceremony is not growth");
    }

    #[test]
    fn expired_entries_are_swept_so_the_cap_counts_live_ceremonies() {
        let store: CeremonyStore<u8> = CeremonyStore::default();
        for index in 0..MAX_PENDING_CEREMONIES {
            store.insert(&format!("key_{index}"), 0).expect("insert");
            store.expire_now(&format!("key_{index}"));
        }

        store
            .insert("key_fresh", 1)
            .expect("abandoned ceremonies must not fill the cap");
        assert_eq!(store.pending_count(), 1);
    }
}
