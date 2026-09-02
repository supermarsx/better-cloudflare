//! The unlock token.
//!
//! # What this is, stated narrowly on purpose
//!
//! An unlock token **proves that a verified WebAuthn assertion completed
//! moments ago, for this account, with this credential.** That is the whole
//! claim. It is not, and given the process model cannot be, an authenticator of
//! a remote caller: anything able to invoke a Tauri command is already inside
//! the application's process boundary, and there is no server-side session
//! identity to bind to. The achievable bindings are account id, credential id,
//! single use, a sixty-second lifetime, and process memory — and those are all
//! implemented below. A later reader should not infer a stronger guarantee than
//! that from the word "token".
//!
//! # Why it is the highest-risk component in the crate
//!
//! `get_vault_secret` releases a decrypted Cloudflare API key on the strength
//! of one of these. The implementation `d05fe59` removed minted a token after
//! an *echo check* — it read the challenge back out of the client's own
//! `clientDataJSON` and compared it to the one it had issued, verifying no
//! signature at all. Anyone who could call the command and knew a stored
//! credential id could forge a token and spend it. Recreating that is the one
//! way this crate can be made worse than the fail-closed state it replaced.
//!
//! Two structural controls, not conventions:
//!
//! - [`UnlockToken`] has private fields and **exactly one construction site**,
//!   inside [`TokenStore::mint`]. Nothing else in the crate can build one.
//! - [`TokenStore::mint`] cannot be called without a [`VerifiedAssertion`],
//!   which can only be built from a [`AuthenticationResult`] — a type this
//!   crate cannot construct, because only
//!   `Webauthn::finish_passkey_authentication` returns one. So "minted only on
//!   the success path of a verified assertion" is enforced by the type system
//!   rather than by where the call happens to sit.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine;
use rand::Rng;
use webauthn_rs::prelude::AuthenticationResult;

use crate::credential::encode_credential_id;

/// How long a minted token stays spendable.
///
/// The frontend consumes it on the next line after receiving it, so sixty
/// seconds is already generous.
pub const TOKEN_TTL: Duration = Duration::from_secs(60);

/// Token secret length. 32 bytes from the process CSPRNG.
const TOKEN_BYTES: usize = 32;

/// Proof that a verified assertion completed.
///
/// The only way to obtain one is from an [`AuthenticationResult`], which only
/// `Webauthn::finish_passkey_authentication` produces. This type exists so that
/// [`TokenStore::mint`]'s precondition is a compile-time obligation instead of
/// a comment.
pub struct VerifiedAssertion {
    account_id: String,
    credential_id: String,
}

impl VerifiedAssertion {
    /// Bind a completed assertion to the account it was performed for.
    pub fn new(account_id: &str, result: &AuthenticationResult) -> Self {
        Self {
            account_id: account_id.to_string(),
            credential_id: encode_credential_id(result.cred_id().as_ref()),
        }
    }
}

/// One live unlock token. Never serialised, never logged, never persisted.
struct UnlockToken {
    secret: [u8; TOKEN_BYTES],
    /// The account the assertion was performed for. `verify` compares the
    /// caller's id against this, so a token minted for key A can never unlock
    /// key B's vault secret.
    account_id: String,
    /// The credential that produced the assertion. Recorded so the audit trail
    /// can name it; never used to decide anything here.
    credential_id: String,
    expires_at: Instant,
}

/// Process-lifetime store of unlock tokens, at most one per account.
#[derive(Default)]
pub struct TokenStore {
    tokens: Mutex<HashMap<String, UnlockToken>>,
}

/// What a successful mint hands back to the caller.
pub struct MintedToken {
    /// base64url, unpadded — the value the frontend receives and spends.
    pub token: String,
    /// The credential that authorised it, for the audit record.
    pub credential_id: String,
}

impl TokenStore {
    /// Recover from lock poisoning rather than panicking: `panic = "abort"` in
    /// the release profile turns an `unwrap()` here into a process kill.
    fn tokens(&self) -> std::sync::MutexGuard<'_, HashMap<String, UnlockToken>> {
        self.tokens.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Mint a token for a verified assertion.
    ///
    /// **This is the only place an [`UnlockToken`] is constructed.** Adding a
    /// second construction site anywhere in this crate re-opens the class of
    /// bug that `d05fe59` closed; if a change appears to need one, the change
    /// is wrong.
    ///
    /// Replaces any token already live for the account, so a second sign-in
    /// invalidates the first rather than leaving two spendable.
    pub fn mint(&self, assertion: &VerifiedAssertion) -> MintedToken {
        let mut secret = [0u8; TOKEN_BYTES];
        rand::rng().fill_bytes(&mut secret);

        let now = Instant::now();
        let mut tokens = self.tokens();
        tokens.retain(|_, token| token.expires_at > now);
        tokens.insert(
            assertion.account_id.clone(),
            UnlockToken {
                secret,
                account_id: assertion.account_id.clone(),
                credential_id: assertion.credential_id.clone(),
                expires_at: now + TOKEN_TTL,
            },
        );

        MintedToken {
            token: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret),
            credential_id: assertion.credential_id.clone(),
        }
    }

    /// Is `presented` the live token for `account_id`?
    ///
    /// Returns a plain `bool` and never an error: a caller that treats an
    /// inconclusive result as "probably fine" is exactly the failure this gate
    /// exists to prevent, so every rejection reason — no token, wrong account,
    /// expired, malformed, mismatched — produces the same `false`.
    ///
    /// With `consume`, a *successful* match removes the token. A failed attempt
    /// deliberately does not: burning the real token on a wrong guess would let
    /// anyone able to call this cancel a legitimate unlock.
    pub fn verify(&self, account_id: &str, presented: &str, consume: bool) -> bool {
        let Ok(presented) = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(presented.trim())
            .map(|bytes| <[u8; TOKEN_BYTES]>::try_from(bytes.as_slice()))
        else {
            return false;
        };
        let Ok(presented) = presented else {
            return false;
        };

        let now = Instant::now();
        let mut tokens = self.tokens();

        let Some(token) = tokens.get(account_id) else {
            return false;
        };
        if token.expires_at <= now {
            tokens.remove(account_id);
            return false;
        }
        // Belt and braces: the map key is the account id, so this cannot
        // currently differ — but the binding is a security property, and it
        // should not depend on a data-structure invariant elsewhere.
        if token.account_id != account_id {
            return false;
        }
        if !constant_time_eq(&token.secret, &presented) {
            return false;
        }

        if consume {
            tokens.remove(account_id);
        }
        true
    }

    /// The credential id behind the live token for `account_id`, if any.
    /// Audit and diagnostic use; never a decision input.
    pub fn credential_for(&self, account_id: &str) -> Option<String> {
        let now = Instant::now();
        self.tokens()
            .get(account_id)
            .filter(|token| token.expires_at > now)
            .map(|token| token.credential_id.clone())
    }

    #[cfg(test)]
    pub fn expire_now(&self, account_id: &str) {
        if let Some(token) = self.tokens().get_mut(account_id) {
            token.expires_at = Instant::now() - Duration::from_secs(1);
        }
    }

    #[cfg(test)]
    pub fn live_count(&self) -> usize {
        self.tokens().len()
    }
}

/// Compare two fixed-length secrets without an early exit.
///
/// Folding over every byte keeps the running time independent of where the
/// first difference is, so a caller cannot recover the secret one byte at a
/// time by measuring. `black_box` stops the optimiser turning the fold back
/// into a short-circuiting comparison. Written here rather than pulled from
/// `subtle` because it is six lines over two fixed-size arrays and the
/// dependency would need its own review.
fn constant_time_eq(left: &[u8; TOKEN_BYTES], right: &[u8; TOKEN_BYTES]) -> bool {
    let mut difference = 0u8;
    for index in 0..TOKEN_BYTES {
        difference |= left[index] ^ right[index];
    }
    std::hint::black_box(difference) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The store's own tests cannot build an `AuthenticationResult`, which is
    /// the point — that type is only produced by the library. The ceremony
    /// tests in `tests/webauthn_ceremonies.rs` cover minting from a real
    /// assertion; these cover the store's rules once a token exists.
    fn assertion(account_id: &str) -> VerifiedAssertion {
        VerifiedAssertion {
            account_id: account_id.to_string(),
            credential_id: "Y3JlZC1pZA".to_string(),
        }
    }

    #[test]
    fn a_minted_token_verifies_once_and_then_never_again() {
        let store = TokenStore::default();
        let minted = store.mint(&assertion("key_a"));

        assert!(store.verify("key_a", &minted.token, true));
        assert!(
            !store.verify("key_a", &minted.token, true),
            "a consumed token must not verify a second time"
        );
    }

    #[test]
    fn a_token_that_was_never_minted_is_refused() {
        let store = TokenStore::default();
        let forged = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0u8; TOKEN_BYTES]);

        assert!(!store.verify("key_a", &forged, true));
        assert!(!store.verify("key_a", "attacker-controlled-token", true));
        assert!(!store.verify("key_a", "", true));
    }

    #[test]
    fn a_token_is_bound_to_the_account_it_was_minted_for() {
        let store = TokenStore::default();
        let minted = store.mint(&assertion("key_a"));

        assert!(
            !store.verify("key_b", &minted.token, true),
            "a token minted for one key must not unlock another"
        );
        assert!(
            store.verify("key_a", &minted.token, true),
            "the rejection must not have consumed the real token"
        );
    }

    #[test]
    fn an_expired_token_is_refused_and_dropped() {
        let store = TokenStore::default();
        let minted = store.mint(&assertion("key_a"));
        store.expire_now("key_a");

        assert!(!store.verify("key_a", &minted.token, true));
        assert_eq!(
            store.live_count(),
            0,
            "an expired token must not be left behind"
        );
    }

    #[test]
    fn a_wrong_guess_does_not_burn_the_live_token() {
        let store = TokenStore::default();
        let minted = store.mint(&assertion("key_a"));
        let wrong = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9u8; TOKEN_BYTES]);

        assert!(!store.verify("key_a", &wrong, true));
        assert!(store.verify("key_a", &minted.token, true));
    }

    #[test]
    fn minting_replaces_any_token_already_live_for_the_account() {
        let store = TokenStore::default();
        let first = store.mint(&assertion("key_a"));
        let second = store.mint(&assertion("key_a"));

        assert_eq!(store.live_count(), 1);
        assert!(!store.verify("key_a", &first.token, true));
        assert!(store.verify("key_a", &second.token, true));
    }

    #[test]
    fn a_non_consuming_check_leaves_the_token_spendable() {
        let store = TokenStore::default();
        let minted = store.mint(&assertion("key_a"));

        assert!(store.verify("key_a", &minted.token, false));
        assert!(store.verify("key_a", &minted.token, true));
        assert!(!store.verify("key_a", &minted.token, false));
    }

    #[test]
    fn tokens_are_unpredictable_and_distinct() {
        let store = TokenStore::default();
        let mut seen = std::collections::HashSet::new();
        for index in 0..64 {
            let minted = store.mint(&assertion(&format!("key_{index}")));
            assert_eq!(
                minted.token.len(),
                43,
                "32 bytes of base64url, unpadded, is 43 characters"
            );
            assert!(seen.insert(minted.token), "token secrets must not repeat");
        }
    }

    #[test]
    fn constant_time_eq_still_agrees_with_equality() {
        let base = [7u8; TOKEN_BYTES];
        assert!(constant_time_eq(&base, &base));
        for index in 0..TOKEN_BYTES {
            let mut other = base;
            other[index] ^= 1;
            assert!(
                !constant_time_eq(&base, &other),
                "difference at byte {index} was not detected"
            );
        }
    }
}
