//! The `YY.N` calendar release tags this project publishes.
//!
//! `.github/scripts/release-contract.mjs` is the authority on what a release
//! tag *is*: `parseReleaseTag` there defines the grammar and `nextReleaseTag`
//! defines how the sequence advances within a year. This module mirrors both
//! rather than inventing a parser, so every tag the release workflow can mint
//! is a tag this check understands, and nothing else is.
//!
//! These are not semver versions and must never be compared as text. `26.13`
//! is year 26, release 13, and it comes *after* `26.9` — while a byte-wise
//! comparison of those two strings claims the opposite, because `'9' > '1'`.
//! Ordering is therefore numeric on the `(year, number)` pair and nothing
//! else.

/// Longest tag text accepted before parsing. A `YY.N` tag is a few bytes;
/// this only stops an absurd `tag_name` from being walked digit by digit.
const MAX_TAG_BYTES: usize = 64;

/// A release tag that parsed: year `YY` and sequence number `N`.
///
/// The derived `Ord` compares `year` first and `number` second, which *is*
/// the comparison this feature needs — so the field order here is
/// load-bearing, and `release_numbers_compare_numerically_not_as_strings`
/// pins the behaviour it produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ReleaseTag {
    pub year: u32,
    pub number: u64,
}

impl ReleaseTag {
    /// The bare tag text, re-rendered from the parsed numbers.
    ///
    /// [`parse_release_tag`] accepts only the canonical spelling — a
    /// two-digit year and a sequence with no leading zero — so this
    /// round-trips any tag it accepted, while dropping a `refs/tags/` prefix
    /// that the grammar tolerates but a release's `tag_name` should never
    /// carry.
    pub fn canonical(self) -> String {
        format!("{:02}.{}", self.year, self.number)
    }
}

/// Parse a `YY.N` release tag, mirroring `parseReleaseTag` in
/// `.github/scripts/release-contract.mjs`: an optional `refs/tags/` prefix,
/// exactly two dot-separated parts, a two-digit year, and a sequence that is
/// non-empty and carries no leading zero unless it is the single digit `0`.
///
/// Anything else is `None`, and `None` means *unknown* — never "older". A tag
/// this cannot read is one the comparison refuses to draw a conclusion from.
///
/// One deliberate deviation from the JavaScript: a sequence too large for
/// `u64` returns `None` here, where `releaseSequence` throws. Both refuse to
/// guess; this one refuses without unwinding, because the value arrives from a
/// network response rather than from the release workflow's own hand.
pub fn parse_release_tag(raw: &str) -> Option<ReleaseTag> {
    if raw.len() > MAX_TAG_BYTES {
        return None;
    }
    let tag = raw.strip_prefix("refs/tags/").unwrap_or(raw);
    // `split_once` leaves any second dot inside `number`, where the digit test
    // below rejects it — that is how "exactly two parts" is enforced.
    let (year, number) = tag.split_once('.')?;
    if year.len() != 2 || number.is_empty() {
        return None;
    }
    if number.len() > 1 && number.starts_with('0') {
        return None;
    }
    if !year.bytes().all(|byte| byte.is_ascii_digit())
        || !number.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some(ReleaseTag {
        year: year.parse().ok()?,
        number: number.parse().ok()?,
    })
}
