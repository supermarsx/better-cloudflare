//! Check-only update notification for Better Cloudflare (no Tauri, no UI):
//! ask GitHub whether a newer `YY.N` release exists and report what was found.
//!
//! **Check only.** Nothing here downloads a release, and nothing here replaces
//! a binary. The project's release assets are unsigned, so there is no
//! signature for an updater to verify and therefore no safe way to install one
//! automatically; Tauri's updater is deliberately not wired up. What this
//! crate produces is an answer — "26.14 exists, published then, here is its
//! page" — and the decision stays with the person reading it.
//!
//! The pieces are separable on purpose, so the comparison can be tested
//! without a socket: [`github::fetch_releases_document`] does the bounded
//! request, [`github::project_releases`] narrows the answer to five fields per
//! release, [`github::select_latest`] picks the highest version, and
//! [`evaluate`] turns that plus the running build's stamp into an
//! [`UpdateCheck`].

pub mod github;
pub mod tag;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use github::{
    default_client, fetch_releases_document, project_releases, select_latest, shared_client,
    validate_release_url, UpdateError, GITHUB_HTML_HOST, GITHUB_RELEASES_URL, GITHUB_REPO,
    UPDATE_MAX_BODY_BYTES, UPDATE_MAX_RELEASES, UPDATE_TIMEOUT, UPDATE_USER_AGENT,
};
pub use tag::{parse_release_tag, ReleaseTag};

/// What a check concluded. Serialised camelCase; the frontend reads these four
/// spellings and no others.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    /// Both versions are known and nothing newer was published.
    UpToDate,
    /// A release newer than the running build exists.
    UpdateAvailable,
    /// The running build carries no tag, or one that cannot be parsed. Never
    /// guessed in either direction.
    UnknownVersion,
    /// The releases list held nothing this check could use.
    NoReleases,
}

/// The release a check settled on, projected to what a notice needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    /// The bare `YY.N` tag.
    pub tag: String,
    /// The release's `html_url`, already checked to be an
    /// `https://github.com/` page by [`validate_release_url`].
    pub url: String,
    /// RFC 3339, which is how `chrono` serialises a UTC timestamp.
    pub published_at: DateTime<Utc>,
    pub prerelease: bool,
}

/// The result of one check.
///
/// Note the absence of `skip_serializing_if`: `current` and `latest` are
/// present as `null` when there is nothing to report, because the frontend
/// reads those keys unconditionally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// What the running build was stamped with, verbatim, or `None` for a
    /// local build that was never stamped.
    pub current: Option<String>,
    pub latest: Option<LatestRelease>,
    pub status: UpdateStatus,
    pub checked_at: DateTime<Utc>,
}

/// One projected release together with its parsed version.
///
/// The parsed tag travels with the release so the comparison never re-parses
/// a string it already understood — and so a release that reaches [`evaluate`]
/// is, by construction, one whose version was readable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedRelease {
    pub version: ReleaseTag,
    pub release: LatestRelease,
}

/// The release tag this build was stamped with at compile time, if any.
///
/// `option_env!` is read at compile time, so a build made without
/// `BC_RELEASE_VERSION` in its environment — any local `cargo build` — reports
/// no version rather than guessing one. The release workflow sets it from the
/// tag it reserved (`.github/workflows/autopublish.yml`).
///
/// An empty or whitespace-only stamp is treated as no stamp: a variable that
/// was exported but never filled in says nothing about what is running.
pub fn embedded_release_tag() -> Option<&'static str> {
    normalize_stamp(option_env!("BC_RELEASE_VERSION"))
}

/// What [`embedded_release_tag`] does to the raw compile-time value, factored
/// out so it can be tested — `option_env!` is fixed when this crate is
/// compiled and a test cannot vary it.
pub(crate) fn normalize_stamp(stamped: Option<&'static str>) -> Option<&'static str> {
    stamped.map(str::trim).filter(|tag| !tag.is_empty())
}

/// Decide what one check concluded, given what is running and what was found.
///
/// The precedence is the one the feature contract states, in that order: an
/// unknown running version wins, because a build that does not know what it is
/// cannot be told that something is newer; then an empty list; then the
/// comparison itself, which is numeric on `(year, number)`.
pub fn evaluate(
    current: Option<&str>,
    latest: Option<ProjectedRelease>,
    checked_at: DateTime<Utc>,
) -> UpdateCheck {
    let running = current.and_then(parse_release_tag);
    let status = match (running, &latest) {
        (None, _) => UpdateStatus::UnknownVersion,
        (Some(_), None) => UpdateStatus::NoReleases,
        (Some(running), Some(found)) if found.version > running => UpdateStatus::UpdateAvailable,
        (Some(_), Some(_)) => UpdateStatus::UpToDate,
    };
    UpdateCheck {
        current: current.map(str::to_string),
        latest: latest.map(|found| found.release),
        status,
        checked_at,
    }
}

/// The whole decision, from a releases document, with no network involved.
/// This is the function the comparison tests drive.
pub fn check_releases(
    document: &Value,
    current: Option<&str>,
    include_prereleases: bool,
    checked_at: DateTime<Utc>,
) -> UpdateCheck {
    evaluate(
        current,
        select_latest(project_releases(document), include_prereleases),
        checked_at,
    )
}

/// Check the project's own releases for something newer than this build.
pub async fn check_for_update(
    client: &reqwest::Client,
    include_prereleases: bool,
) -> Result<UpdateCheck, UpdateError> {
    check_for_update_from(
        client,
        GITHUB_RELEASES_URL,
        embedded_release_tag(),
        include_prereleases,
    )
    .await
}

/// Same as [`check_for_update`] with an explicit releases URL and running
/// version, so a test can point at a local socket and state what is running
/// instead of depending on how the test binary itself was built.
pub async fn check_for_update_from(
    client: &reqwest::Client,
    releases_url: &str,
    current: Option<&str>,
    include_prereleases: bool,
) -> Result<UpdateCheck, UpdateError> {
    let document = fetch_releases_document(client, releases_url).await?;
    Ok(check_releases(
        &document,
        current,
        include_prereleases,
        Utc::now(),
    ))
}

#[cfg(test)]
mod tests;
