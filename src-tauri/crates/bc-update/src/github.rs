//! Asking GitHub, over a bounded unauthenticated request, which releases
//! exist — and projecting the answer down to the five fields a check-only
//! notifier needs.
//!
//! `bc-notify`'s `rdap.rs` is this repository's precedent for outbound HTTP
//! and the bounds here are the same ones, for the same reasons: a per-request
//! timeout, HTTPS-only redirects bounded in depth, a streaming body read that
//! stops at a byte ceiling whether or not a length was declared, and a
//! projection of the response rather than a passthrough of it.
//!
//! Three things this module deliberately does not do:
//!
//! * It sends **no credentials**. The repository is public and the releases
//!   list is public, so the request is unauthenticated. No token is read from
//!   the environment, from storage, or from a caller — there is no parameter
//!   to pass one through. A check for a newer version is not a reason to put a
//!   credential on the wire.
//! * It never reads a release's `body`. Release notes are unbounded
//!   author-written prose; nothing in "is there a newer version" needs them,
//!   and a security-sensitive app has no business pulling that text into its
//!   process, its UI, or a model's context. The same goes for `name` (the
//!   release title) and for every contributor identity the response carries.
//! * It never retries. `403` and `429` mean GitHub is rate-limiting an
//!   unauthenticated caller; answering that by asking again is how a check
//!   becomes the problem. The status is surfaced to the caller once and the
//!   round ends.

use std::sync::OnceLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::Value;
use thiserror::Error;
use url::Url;

use crate::tag::parse_release_tag;
use crate::{LatestRelease, ProjectedRelease};

/// The repository whose releases are checked.
pub const GITHUB_REPO: &str = "supermarsx/better-cloudflare";
/// The releases list endpoint. `check_for_update_from` takes this as a
/// parameter so a test can point at a local socket instead.
pub const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/supermarsx/better-cloudflare/releases";
/// The only host a release link may point at.
pub const GITHUB_HTML_HOST: &str = "github.com";
/// GitHub requires a `User-Agent` and rejects requests without one; this names
/// the app and where it comes from, so a rate-limit investigation has
/// something to go on.
pub const UPDATE_USER_AGENT: &str =
    "better-cloudflare-update/0.1 (+https://github.com/supermarsx/better-cloudflare)";

pub const UPDATE_TIMEOUT: Duration = Duration::from_secs(10);
/// Ceiling on the response body. Larger than RDAP's because the releases list
/// carries every release's notes whether or not they are wanted — they are
/// streamed past and dropped, but they still have to fit under a bound.
pub const UPDATE_MAX_BODY_BYTES: usize = 512 * 1024;
/// Redirect hops followed before the chain is refused. `api.github.com`
/// answers directly, so the normal depth is 0.
pub const UPDATE_MAX_REDIRECTS: usize = 5;
/// How many releases one check considers. `/releases` is paginated and
/// newest-first; this is both the page size requested and the number of
/// entries parsed, so the two cannot drift apart.
pub const UPDATE_MAX_RELEASES: usize = 10;

#[derive(Debug, Error)]
pub enum UpdateError {
    #[error("update check timed out after {}s", UPDATE_TIMEOUT.as_secs())]
    Timeout,
    #[error("update check failed: {0}")]
    Http(String),
    #[error("GitHub is rate-limiting this check (HTTP {0}); try again later")]
    RateLimited(u16),
    #[error("GitHub returned HTTP {0}")]
    Status(u16),
    #[error("release list exceeded {UPDATE_MAX_BODY_BYTES} bytes")]
    TooLarge,
    #[error("release list was not valid JSON: {0}")]
    Parse(String),
}

/// A hung request is as bad as a slow one for a bounded check, so a timeout
/// gets its own variant rather than arriving as reqwest prose.
fn describe_transport_error(error: reqwest::Error) -> UpdateError {
    if error.is_timeout() {
        UpdateError::Timeout
    } else {
        UpdateError::Http(error.to_string())
    }
}

/// What the redirect policy does with one hop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RedirectDecision {
    Follow,
    /// A redirect away from HTTPS is not followed. The 3xx response is handed
    /// back instead, so the caller sees [`UpdateError::Status`] rather than a
    /// cleartext request to the downgraded URL.
    StopNonHttps,
    TooDeep,
}

/// Redirects are followed deliberately and only to HTTPS, at most
/// [`UPDATE_MAX_REDIRECTS`] hops.
pub(crate) fn redirect_decision(previous_hops: usize, scheme: &str) -> RedirectDecision {
    if previous_hops > UPDATE_MAX_REDIRECTS {
        RedirectDecision::TooDeep
    } else if !scheme.eq_ignore_ascii_case("https") {
        RedirectDecision::StopNonHttps
    } else {
        RedirectDecision::Follow
    }
}

/// Build the HTTP client used for update checks: 10 s timeout, HTTPS-only
/// redirects bounded at [`UPDATE_MAX_REDIRECTS`] hops, and a `User-Agent`
/// naming the app.
pub fn default_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(UPDATE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(
            |attempt| match redirect_decision(attempt.previous().len(), attempt.url().scheme()) {
                RedirectDecision::Follow => attempt.follow(),
                RedirectDecision::StopNonHttps => attempt.stop(),
                RedirectDecision::TooDeep => {
                    attempt.error("update redirect chain exceeded its depth bound")
                }
            },
        ))
        .user_agent(UPDATE_USER_AGENT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// A process-wide client. An update check is a one-off with no loop of its own
/// to hang a client on, and building a fresh TLS stack per check is waste.
pub fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(default_client)
}

/// Fetch one page of the releases list, bounded in every direction: a
/// per-request timeout (restated here so a client built without one still
/// cannot hang a caller), a page size, and a streaming body read that stops at
/// [`UPDATE_MAX_BODY_BYTES`] whether or not GitHub declared a length.
///
/// `releases_url` must carry no query string of its own; the page size is
/// appended here.
pub async fn fetch_releases_document(
    client: &reqwest::Client,
    releases_url: &str,
) -> Result<Value, UpdateError> {
    let url = format!("{releases_url}?per_page={UPDATE_MAX_RELEASES}");
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(UPDATE_TIMEOUT)
        .send()
        .await
        .map_err(describe_transport_error)?;
    let status = response.status();
    // Rate limiting is an answer, not a fault: it is reported once and this
    // round ends. Nothing above retries, and nothing here loops.
    if matches!(status.as_u16(), 403 | 429) {
        return Err(UpdateError::RateLimited(status.as_u16()));
    }
    if !status.is_success() {
        return Err(UpdateError::Status(status.as_u16()));
    }
    if let Some(length) = response.content_length() {
        if length > UPDATE_MAX_BODY_BYTES as u64 {
            return Err(UpdateError::TooLarge);
        }
    }
    let mut body: Vec<u8> = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(describe_transport_error)? {
        if body.len() + chunk.len() > UPDATE_MAX_BODY_BYTES {
            return Err(UpdateError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|error| UpdateError::Parse(error.to_string()))
}

/// Accept a release's `html_url` only if it is an `https://github.com/` page,
/// returning the parsed and normalised form.
///
/// This URL ends up in a link a user may click, so it is checked rather than
/// trusted: HTTPS only, the host exactly `github.com` (which rules out
/// `github.com.evil.example` and `evil.example/github.com/…` alike, something
/// a prefix match on the string would not), no port, no embedded credentials,
/// and an actual page path rather than a bare host.
pub fn validate_release_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    if url.host_str()? != GITHUB_HTML_HOST {
        return None;
    }
    if url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if url.path().len() <= 1 {
        return None;
    }
    Some(url.to_string())
}

/// Read one release object, keeping only `tag_name`, `html_url`,
/// `published_at`, `prerelease` and `draft`, and returning `None` for anything
/// that cannot be classified from those five.
///
/// Every other field the response carries — `body` and `name` (author-written
/// prose), `author`, `assets`, `tarball_url`, `upload_url`, `node_id`,
/// `target_commitish`, `reactions`, … — is never read at all, so there is no
/// path by which it reaches a caller.
///
/// Unprojectable is not "older": a release with a tag this build cannot parse,
/// a link it will not vouch for, a date it cannot read, or a draft/prerelease
/// flag that is missing or not a boolean is dropped rather than guessed at.
/// The check then reports on what remains, which may be nothing at all.
fn project_release(release: &Value) -> Option<ProjectedRelease> {
    // Fail closed on the two state flags: a release whose draft/prerelease
    // status cannot be read is a release this check will not classify.
    if release.get("draft")?.as_bool()? {
        return None;
    }
    let prerelease = release.get("prerelease")?.as_bool()?;
    let version = parse_release_tag(release.get("tag_name")?.as_str()?)?;
    let url = validate_release_url(release.get("html_url")?.as_str()?)?;
    // GitHub stamps `published_at` in strict RFC 3339; a non-draft release
    // always carries one. Anything else is unreadable, not assumed.
    let published_at = DateTime::parse_from_rfc3339(release.get("published_at")?.as_str()?)
        .ok()?
        .with_timezone(&Utc);
    Some(ProjectedRelease {
        version,
        release: LatestRelease {
            // The parsed tag re-rendered, so a `refs/tags/`-prefixed name
            // cannot reach the UI even though the grammar tolerates one.
            tag: version.canonical(),
            url,
            published_at,
            prerelease,
        },
    })
}

/// Project a releases list, dropping drafts always and anything unprojectable,
/// and considering at most [`UPDATE_MAX_RELEASES`] entries.
///
/// A document that is not a JSON array — an error object, say — projects to
/// nothing, which the caller reports as "no releases" rather than as a
/// comparison it could not make.
pub fn project_releases(document: &Value) -> Vec<ProjectedRelease> {
    document
        .as_array()
        .map(|releases| {
            releases
                .iter()
                .take(UPDATE_MAX_RELEASES)
                .filter_map(project_release)
                .collect()
        })
        .unwrap_or_default()
}

/// The highest-versioned projected release, excluding prereleases unless the
/// caller asked for them.
///
/// The list GitHub returns is ordered by creation date, which is not the same
/// thing as ordered by version, so the answer is a maximum over the parsed
/// `(year, number)` pairs rather than "the first entry". Tags are unique per
/// release, so there is no tie to break.
pub fn select_latest(
    releases: Vec<ProjectedRelease>,
    include_prereleases: bool,
) -> Option<ProjectedRelease> {
    releases
        .into_iter()
        .filter(|candidate| include_prereleases || !candidate.release.prerelease)
        .max_by_key(|candidate| candidate.version)
}
