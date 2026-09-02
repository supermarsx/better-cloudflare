//! Legacy passkey records: `passkeys:{id}`.
//!
//! These are the records the pre-`d05fe59` implementation wrote — whatever JSON
//! the browser handed it, stored without verifying anything. No public key was
//! ever captured, so no assertion can be checked against them and nothing can
//! upgrade them. They are listable and deletable, and that is all they will
//! ever be.
//!
//! # This module is a verbatim move, and should stay one
//!
//! Everything here previously lived as associated functions on
//! `PasskeyManager`. It was moved, not rewritten. `94d74d1` fixed two real bugs
//! in this logic:
//!
//! - a cross-alphabet Base64 collision, where `ab-c` and `ab+c` decode to the
//!   same octets through *different* alphabets, so deleting one credential
//!   removed another;
//! - records with a blank `id`, which could be listed but never addressed by a
//!   delete, leaving them permanently stuck in the user's list.
//!
//! The tests in `tests/legacy_record_shapes.rs` are precise about both. Treat
//! this module as frozen: new work belongs in [`crate::credential`], which
//! serves the verified store and deliberately does *not* share this leniency.

use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::{alphabet, Engine};
use serde_json::Value;

/// Legacy records for `id`.
pub fn legacy_storage_key(id: &str) -> String {
    format!("passkeys:{id}")
}

/// Padding is a serialisation detail rather than a credential difference, so
/// both engines below accept a padded or unpadded spelling of the same bytes.
/// Non-canonical trailing bits stay rejected: such a spelling is not a Base64
/// encoding of the bytes it nearly decodes to.
const ANY_PADDING: GeneralPurposeConfig =
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent);
const URL_SAFE_ANY_PAD: GeneralPurpose = GeneralPurpose::new(&alphabet::URL_SAFE, ANY_PADDING);
const STANDARD_ANY_PAD: GeneralPurpose = GeneralPurpose::new(&alphabet::STANDARD, ANY_PADDING);

/// The Base64 alphabet(s) a credential-id spelling is admissible in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CredentialAlphabet {
    UrlSafe,
    Standard,
    /// Contains no character that distinguishes the alphabets.
    Either,
    /// Mixes characters exclusive to both alphabets; not valid Base64 at all.
    Neither,
}

impl CredentialAlphabet {
    /// Could both spellings have come from one alphabet?
    fn can_share_spelling_with(self, other: Self) -> bool {
        match (self, other) {
            (Self::Neither, _) | (_, Self::Neither) => false,
            (Self::Either, _) | (_, Self::Either) => true,
            (left, right) => left == right,
        }
    }
}

/// Which Base64 alphabet a stored credential-id spelling could have been
/// written in, inferred from the characters that distinguish the two standard
/// alphabets.
fn alphabet_of(value: &str) -> CredentialAlphabet {
    let url_safe = value.contains(['-', '_']);
    let standard = value.contains(['+', '/']);
    match (url_safe, standard) {
        // `-_` and `+/` in one string: no single alphabet spells this.
        (true, true) => CredentialAlphabet::Neither,
        (true, false) => CredentialAlphabet::UrlSafe,
        (false, true) => CredentialAlphabet::Standard,
        // No distinguishing character: both alphabets decode it identically.
        (false, false) => CredentialAlphabet::Either,
    }
}

/// Decode a credential id together with the alphabet it was spelled in.
///
/// Padding is accepted or omitted on either side, because legacy records were
/// written with whichever spelling the browser happened to supply. The
/// alphabet, unlike the padding, is *not* normalised away: it is returned so
/// the caller can refuse to compare across alphabets.
fn decode_credential_id(value: &str) -> Option<(Vec<u8>, CredentialAlphabet)> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let alphabet = alphabet_of(value);
    let decoded = match alphabet {
        CredentialAlphabet::UrlSafe | CredentialAlphabet::Either => URL_SAFE_ANY_PAD.decode(value),
        CredentialAlphabet::Standard => STANDARD_ANY_PAD.decode(value),
        CredentialAlphabet::Neither => return None,
    };
    decoded.ok().map(|bytes| (bytes, alphabet))
}

/// Compare two credential ids.
///
/// Matching stays deliberately lenient so that a record written by an older
/// build is still deletable, but the leniency is bounded to differences that
/// are *not* semantic: surrounding whitespace, and the presence or absence of
/// Base64 padding. Two spellings that decode to the same octets through
/// *different* alphabets are different credentials, and matching them would let
/// one delete remove another credential's record.
///
/// Restricting this costs nothing for recovery: the delete path is always
/// reached from `list_passkeys`, which reports the stored spelling verbatim, so
/// the stored and requested ids agree on alphabet by construction and usually
/// match as exact strings before any decoding happens.
pub fn credential_ids_match(left: &str, right: &str) -> bool {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    match (decode_credential_id(left), decode_credential_id(right)) {
        (Some((left_bytes, left_alphabet)), Some((right_bytes, right_alphabet))) => {
            left_alphabet.can_share_spelling_with(right_alphabet) && left_bytes == right_bytes
        }
        _ => false,
    }
}

/// The stored identifier for a record, or `None` when the record carries no
/// usable one. A present-but-blank `id` counts as unusable: it can never be
/// matched by a delete, so it must fall through to a synthetic handle.
pub fn stored_credential_id(credential: &Value) -> Option<&str> {
    ["id", "rawId"]
        .into_iter()
        .filter_map(|field| credential.get(field).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
}

/// Stable handle for a record that has no usable stored identifier, so the
/// manager can still address it.
pub fn synthetic_credential_id(index: usize) -> String {
    format!("legacy_credential_{index}")
}

/// The handle `list_passkeys` reports for the record at `index`.
pub fn reported_credential_id(credential: &Value, index: usize) -> String {
    stored_credential_id(credential)
        .map(str::to_string)
        .unwrap_or_else(|| synthetic_credential_id(index))
}

/// Does `requested` address the record at `index`?
///
/// Records with a stored id are matched on that id; records without one are
/// matched only on the exact synthetic handle `list_passkeys` reported for
/// them. Synthetic handles are compared literally - they are app-generated
/// names, not Base64 payloads, so no decoding leniency applies to them.
pub fn credential_matches(credential: &Value, index: usize, requested: &str) -> bool {
    match stored_credential_id(credential) {
        Some(stored) => credential_ids_match(stored, requested),
        None => requested.trim() == synthetic_credential_id(index),
    }
}

/// The counter a legacy record claims. Display only — it was never verified
/// against anything, so nothing may decide on it.
pub fn claimed_counter(credential: &Value) -> u64 {
    credential
        .get("counter")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}
