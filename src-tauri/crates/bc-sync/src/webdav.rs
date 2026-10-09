//! The Nextcloud engine, over WebDAV.
//!
//! Nextcloud is addressed through its `remote.php/dav/files/<user>/…`
//! collection, with an app password rather than the account password — which
//! is what Nextcloud's own documentation tells third-party clients to use, and
//! what lets the user revoke this app's access without changing their login.
//!
//! The generation guard here is a real HTTP precondition: Nextcloud returns an
//! `ETag` on the manifest and honours `If-Match` on a `PUT`, so a write that
//! loses a race is refused by the server rather than by a check this process
//! did a moment earlier. That is the strongest guard either provider offers
//! and the reason this engine is the one the UI recommends.
//!
//! # Why a push is four requests
//!
//! The blob is staged under [`incoming_name`] and only *moved* into place once
//! the guarded manifest write has been accepted. The obvious sequence — write
//! the blob, then write the manifest — destroys the live blob before the guard
//! has had a chance to refuse, which on a credential store means the losing
//! device has already overwritten the winning device's keys by the time it is
//! told it lost. Staging means a refusal costs nothing but a stray file.
//!
//! # The windows this leaves open
//!
//! Four requests are not a transaction, and WebDAV offers nothing that would
//! make them one. The sequence is ordered so that every surviving window is
//! *detectable and recoverable* rather than silent:
//!
//! - **`MOVE` fails after the manifest was accepted.** The manifest now
//!   describes bytes that are not the live blob, so
//!   [`SyncManifest::describes`] reports the pair as `Corrupt` on the next
//!   pull rather than handing anyone the wrong vault — and the staged file
//!   still holds exactly the bytes the manifest describes, so the repair is a
//!   `MOVE` and not a re-upload. This is the window that matters, and it is
//!   deliberately the one left: the alternative ordering trades it for a lost
//!   write.
//! - **A reader lands between the manifest write and the `MOVE`.** It sees
//!   the same mismatch and refuses for the same reason. A pull that refuses
//!   is a pull the user retries.
//! - **The manifest write fails for a reason that is not the guard.** The
//!   staged file is left behind; nothing points at it, nothing reads it, and
//!   the next push overwrites it.
//! - **The `DELETE` of the staged file fails on the refusal path.** Same
//!   story, and the refusal is reported rather than replaced by the cleanup's
//!   error — the caller needs to hear "your write was refused", not "DELETE
//!   returned 503".
//!
//! What is *not* a window: a push that loses the race cannot replace the live
//! blob, in any interleaving, because the only request that touches
//! [`SYNC_BLOB_NAME`] runs after the server has accepted the precondition.

use std::sync::Mutex;
use std::time::Duration;

use crate::{
    GenerationGuard, GuardRefused, PutOutcome, SyncEngine, SyncError, SyncManifest,
    MAX_SYNC_ENVELOPE_BYTES, SYNC_BLOB_NAME, SYNC_MANIFEST_NAME,
};

/// The largest manifest this will read.
///
/// A manifest is a few hundred bytes, so this is pure headroom. It exists
/// because the body is JSON from a store this process does not control, and a
/// bound applied after the read is not a bound — the same reasoning, and the
/// same shape, as `bc_notify::rdap::RDAP_MAX_BODY_BYTES`.
const MAX_MANIFEST_BYTES: usize = 64 * 1024;

/// How long one request may take before it is abandoned.
///
/// `reqwest::Client::new()` has no timeout at all, which on a desktop app
/// means a server that accepts the connection and then says nothing leaves a
/// push spinning with no way out but quitting. The payload is bounded at
/// 96 KiB in both directions, so a request that has not finished in thirty
/// seconds is not going to. Matches `gdrive::DRIVE_TIMEOUT`, for the same
/// reason and deliberately with the same number.
const WEBDAV_TIMEOUT: Duration = Duration::from_secs(30);

fn http_client() -> Result<reqwest::Client, SyncError> {
    reqwest::Client::builder()
        .timeout(WEBDAV_TIMEOUT)
        .build()
        .map_err(|error| SyncError::Unreachable(error.to_string()))
}

/// Where the sealed bytes are staged before they become the live blob.
///
/// Derived from [`SYNC_BLOB_NAME`] rather than spelled out, so the two cannot
/// drift apart and leave a staged file nothing cleans up.
fn incoming_name() -> String {
    format!("{SYNC_BLOB_NAME}.incoming")
}

/// The name a conflict resolution's discarded side is kept under.
///
/// `better-cloudflare-vault.<suffix>.enc`, keeping the extension last so the
/// archives sort next to the live blob and are recognisable as the same kind
/// of thing.
fn archive_name(suffix: &str) -> String {
    let stem = SYNC_BLOB_NAME
        .strip_suffix(".enc")
        .unwrap_or(SYNC_BLOB_NAME);
    format!("{stem}.{suffix}.enc")
}

/// The manifest kept beside an archived blob.
///
/// `.json` rather than `.enc`, because it is not an envelope — it is the
/// plaintext record of the parameters the envelope was sealed with, and a
/// `.enc` extension on readable JSON invites someone to try to decrypt it.
fn archive_manifest_name(suffix: &str) -> String {
    let stem = SYNC_BLOB_NAME
        .strip_suffix(".enc")
        .unwrap_or(SYNC_BLOB_NAME);
    format!("{stem}.{suffix}.json")
}

/// WebDAV's verbs are not in `reqwest::Method`'s constant set.
///
/// Every name passed here is a literal in this file and a valid HTTP token,
/// so the parse cannot fail. The `expect` says so rather than substituting a
/// fallback method, which would quietly send a different request.
fn dav_method(name: &str) -> reqwest::Method {
    reqwest::Method::from_bytes(name.as_bytes()).expect("a WebDAV verb is a valid HTTP token")
}

/// Did this status mean "the parent collection is not there"?
///
/// RFC 4918 specifies 409 Conflict for a `PUT` whose parent is missing and
/// that is what Nextcloud answers, but other WebDAV servers answer 404. Both
/// mean the same thing to the one caller of this, so both lead to one `MKCOL`.
fn collection_missing(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::CONFLICT
}

/// The precondition a `PUT` carries, which is where the guard is enforced.
enum Precondition {
    /// `If-None-Match: *` — the first push, whose guard is "there must be
    /// nothing there". The server, not this process, decides whether that
    /// held.
    ManifestAbsent,
    /// `If-Match` against the validator of the manifest the caller read.
    Validator(String),
}

/// What the guard resolved to before any bytes were written.
enum GuardCheck {
    Proceed(Precondition),
    /// The remote had already moved, and this is what it holds.
    Refuse(SyncManifest),
}

/// A configured Nextcloud target.
pub struct WebDavEngine {
    client: reqwest::Client,
    base: url::Url,
    username: String,
    app_password: String,
    /// The `ETag` the last [`SyncEngine::fetch_manifest`] saw, if any.
    ///
    /// # Why this is cached rather than re-read in `put`
    ///
    /// The validator the *caller* read is the one its conflict decision was
    /// based on, so `If-Match` against it means "refuse unless the remote is
    /// still exactly the thing I compared against". A validator re-read at
    /// the top of `put` would only prove the remote had not moved in the
    /// preceding millisecond — it would let a push whose generation check ran
    /// against a manifest two devices ago through, as long as nothing changed
    /// during `put` itself. It also costs a round trip that the push flow has
    /// already paid for, since a push reads the manifest to decide whether it
    /// has anything to do.
    ///
    /// `put` falls back to re-reading when there is nothing cached, because
    /// the trait does not require a `fetch_manifest` first; that path checks
    /// the generation itself, since an `If-Match` against a freshly read
    /// validator would otherwise cheerfully replace a generation the caller
    /// never saw.
    manifest_etag: Mutex<Option<String>>,
}

impl WebDavEngine {
    /// Validate the URL and build a client.
    ///
    /// The scheme is checked here rather than at the request: an `http://`
    /// collection would send an app password in the clear, and a `file://`
    /// one would turn a settings field into a local-file read.
    pub fn new(base_url: &str, username: &str, app_password: &str) -> Result<Self, SyncError> {
        let base = url::Url::parse(base_url).map_err(|_| SyncError::NotConfigured)?;
        if base.scheme() != "https" {
            return Err(SyncError::NotConfigured);
        }
        Ok(Self {
            client: http_client()?,
            base,
            username: username.to_string(),
            app_password: app_password.to_string(),
            manifest_etag: Mutex::new(None),
        })
    }

    /// Build an engine against a plaintext loopback stub.
    ///
    /// [`Self::new`] refuses anything but https for the reason its own comment
    /// gives, and the tests below run against an `http` socket. A constructor
    /// that exists only under `cfg(test)` is the narrowest way to have both:
    /// no release build can reach an unencrypted collection through it.
    #[cfg(test)]
    fn against_test_socket(base_url: &str, username: &str, app_password: &str) -> Self {
        Self {
            client: http_client().expect("a client with only a timeout set always builds"),
            base: url::Url::parse(base_url).expect("the test harness builds this URL"),
            username: username.to_string(),
            app_password: app_password.to_string(),
            manifest_etag: Mutex::new(None),
        }
    }

    /// The URL of one object directly under the collection.
    ///
    /// `push` percent-encodes the segment, which is what keeps a caller-chosen
    /// archive suffix from becoming a path: a `/` in it arrives at the server
    /// as `%2F` and stays inside one segment rather than addressing a sibling
    /// collection.
    fn child(&self, name: &str) -> Result<url::Url, SyncError> {
        let mut url = self.base.clone();
        {
            let mut segments = url
                .path_segments_mut()
                // Only a cannot-be-a-base URL (`mailto:`, `data:`) has no path
                // segments, and the constructors admit only http(s). Refusing
                // in the impossible branch keeps it from falling back to the
                // collection URL itself, which is a `PUT` over the directory.
                .map_err(|_| SyncError::NotConfigured)?;
            // A collection URL means the same thing typed with or without a
            // trailing slash; dropping the empty final segment makes both
            // spellings address the same object instead of one of them
            // producing a `//` in the path.
            segments.pop_if_empty().push(name);
        }
        Ok(url)
    }

    fn request(&self, method: reqwest::Method, url: url::Url) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .basic_auth(&self.username, Some(&self.app_password))
    }

    fn cached_etag(&self) -> Option<String> {
        match self.manifest_etag.lock() {
            Ok(guard) => guard.as_ref().cloned(),
            // A poisoned lock means a panic while a validator was being
            // stored. "No validator" is the safe reading: it costs a re-read,
            // not a guard.
            Err(_) => None,
        }
    }

    fn remember_etag(&self, etag: Option<String>) {
        if let Ok(mut guard) = self.manifest_etag.lock() {
            *guard = etag;
        }
    }

    /// Resolve the guard into a precondition, before anything is written.
    ///
    /// This runs first so that a guard which has already lost costs no upload
    /// and leaves no staged file behind.
    async fn check_guard(&self, guard: GenerationGuard) -> Result<GuardCheck, SyncError> {
        let Some(generation) = guard.0 else {
            return Ok(GuardCheck::Proceed(Precondition::ManifestAbsent));
        };
        if let Some(etag) = self.cached_etag() {
            return Ok(GuardCheck::Proceed(Precondition::Validator(etag)));
        }
        // No `fetch_manifest` preceded this `put`. Read the manifest now, and
        // check the generation here, because `If-Match` against a validator
        // this method just read proves only that nothing moved during `put`.
        let Some(remote) = self.fetch_manifest().await? else {
            // The caller means to replace generation `n` and the remote has no
            // manifest to prove it still holds one. `GuardRefused` requires a
            // remote manifest, so this cannot be reported as a refusal; what
            // it reports instead is the state the remote is actually in — a
            // blob with nothing describing it, which is what `describes` calls
            // corrupt and what sends the UI to a repair rather than a retry.
            return Err(SyncError::Corrupt);
        };
        if remote.generation != generation {
            return Ok(GuardCheck::Refuse(remote));
        }
        match self.cached_etag() {
            Some(etag) => Ok(GuardCheck::Proceed(Precondition::Validator(etag))),
            // A server that returns no `ETag` on the manifest cannot be
            // guarded with `If-Match`, and an unguarded write to a credential
            // store is the thing this crate exists to prevent. Refusing the
            // push is the only safe answer; Nextcloud always sends one.
            None => Err(SyncError::Provider(
                "the collection returned no ETag, so a write cannot be guarded".into(),
            )),
        }
    }

    async fn send_put(
        &self,
        name: &str,
        content_type: &str,
        body: &[u8],
        precondition: Option<&Precondition>,
    ) -> Result<reqwest::Response, SyncError> {
        let request = self
            .request(reqwest::Method::PUT, self.child(name)?)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body.to_vec());
        let request = match precondition {
            None => request,
            Some(Precondition::ManifestAbsent) => {
                request.header(reqwest::header::IF_NONE_MATCH, "*")
            }
            // The validator goes back out exactly as it arrived, quotes and
            // any `W/` prefix included. A weak validator is not usable with
            // `If-Match`, so a server that sent one gets its own write
            // refused — which is the right direction to fail in.
            Some(Precondition::Validator(etag)) => {
                request.header(reqwest::header::IF_MATCH, etag.as_str())
            }
        };
        request.send().await.map_err(SyncError::from_request)
    }

    /// `PUT` an object, creating the collection once if it is not there.
    ///
    /// `created_collection` is threaded through the whole push rather than
    /// kept per request, so that two `PUT`s into a missing collection cannot
    /// become two `MKCOL`s — and so a server that answers 404 to the retry as
    /// well returns that 404 instead of looping.
    async fn put_object(
        &self,
        name: &str,
        content_type: &str,
        body: &[u8],
        precondition: Option<&Precondition>,
        created_collection: &mut bool,
    ) -> Result<reqwest::Response, SyncError> {
        let response = self
            .send_put(name, content_type, body, precondition)
            .await?;
        if *created_collection || !collection_missing(response.status()) {
            return Ok(response);
        }
        self.create_collection().await?;
        *created_collection = true;
        self.send_put(name, content_type, body, precondition).await
    }

    async fn create_collection(&self) -> Result<(), SyncError> {
        let response = self
            .request(dav_method("MKCOL"), self.base.clone())
            .send()
            .await
            .map_err(SyncError::from_request)?;
        let status = response.status();
        // 405 is "a collection is already there", which satisfies the one
        // thing this is called to guarantee. A *parent* that is missing comes
        // back as 409, and that is not walked up and created: building an
        // arbitrary depth of collections under a URL someone typed into a
        // settings field is not this engine's business.
        if status.is_success() || status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Ok(());
        }
        Err(SyncError::from_status(status))
    }

    /// Remove the staged bytes, ignoring whether it worked. See the module
    /// header for why the failure is swallowed rather than returned.
    async fn discard_incoming(&self) {
        if let Ok(url) = self.child(&incoming_name()) {
            let _ = self.request(reqwest::Method::DELETE, url).send().await;
        }
    }

    /// Re-read the manifest for the refusal path.
    ///
    /// A refusal has to carry what the remote actually holds, so a manifest
    /// that has vanished or will not parse between the 412 and this read
    /// leaves nothing to report it with. `Corrupt` is what that is.
    async fn remote_for_refusal(&self) -> Result<SyncManifest, SyncError> {
        self.fetch_manifest().await?.ok_or(SyncError::Corrupt)
    }
}

fn etag_of(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// Read a response body, refusing one larger than `limit` *while* it arrives.
///
/// The declared length is checked first because it is free, but it is not the
/// bound: a chunked response declares no length at all, so the only limit
/// that holds against a store this process does not control is one applied to
/// each chunk as it lands. Copied in shape from
/// `bc_notify::rdap::fetch_rdap_document` for that reason.
async fn read_bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, SyncError> {
    if let Some(length) = response.content_length() {
        if length > limit as u64 {
            return Err(SyncError::TooLarge);
        }
    }
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(SyncError::from_request)? {
        if body.len() + chunk.len() > limit {
            return Err(SyncError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[async_trait::async_trait]
impl SyncEngine for WebDavEngine {
    async fn probe(&self) -> Result<(), SyncError> {
        // `Depth: 0` asks about the collection itself and nothing in it, so
        // the answer stays one short document however many vaults, archives
        // and staged files are sitting there. The body asks for
        // `resourcetype` alone for the same reason: an `allprop` PROPFIND on
        // a Nextcloud collection is a great deal of XML to prove a password
        // works.
        let response = self
            .request(dav_method("PROPFIND"), self.base.clone())
            .header("Depth", "0")
            .header(reqwest::header::CONTENT_TYPE, "application/xml")
            .body(
                r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#,
            )
            .send()
            .await
            .map_err(SyncError::from_request)?;

        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        match status {
            // A configured-but-never-pushed account must probe clean — the
            // trait says so, and the collection is created by the first push.
            // Reporting "not found" here would make a correctly configured
            // account look broken until someone pushed, which is exactly
            // backwards for a button whose job is to check the credential.
            reqwest::StatusCode::NOT_FOUND => Ok(()),
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                Err(SyncError::Unauthorised)
            }
            other => Err(SyncError::from_status(other)),
        }
    }

    async fn fetch_manifest(&self) -> Result<Option<SyncManifest>, SyncError> {
        let response = self
            .request(reqwest::Method::GET, self.child(SYNC_MANIFEST_NAME)?)
            .send()
            .await
            .map_err(SyncError::from_request)?;

        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            // Clear rather than leave a validator from an earlier read: the
            // manifest this one is about is not there, and a stale `If-Match`
            // would guard a write against something that no longer exists.
            self.remember_etag(None);
            return Ok(None);
        }
        if !status.is_success() {
            return Err(SyncError::from_status(status));
        }

        let etag = etag_of(&response);
        let body = read_bounded(response, MAX_MANIFEST_BYTES).await?;
        let manifest = SyncManifest::parse(&String::from_utf8_lossy(&body))?;
        // Recorded only once the manifest parsed: a validator for a document
        // the caller never got back is a validator nothing is guarding.
        self.remember_etag(etag);
        Ok(Some(manifest))
    }

    async fn fetch_blob(&self) -> Result<Vec<u8>, SyncError> {
        let response = self
            .request(reqwest::Method::GET, self.child(SYNC_BLOB_NAME)?)
            .send()
            .await
            .map_err(SyncError::from_request)?;

        let status = response.status();
        if !status.is_success() {
            // 404 becomes `NoRemoteBlob` through `from_status`, which is the
            // one this caller wants.
            return Err(SyncError::from_status(status));
        }
        read_bounded(response, MAX_SYNC_ENVELOPE_BYTES).await
    }

    /// Stage, guard, then move. See the module header for the ordering and
    /// for the windows it leaves open.
    async fn put(
        &self,
        blob: &[u8],
        manifest: &SyncManifest,
        guard: GenerationGuard,
    ) -> Result<PutOutcome, SyncError> {
        let precondition = match self.check_guard(guard).await? {
            GuardCheck::Proceed(precondition) => precondition,
            GuardCheck::Refuse(remote) => return Ok(PutOutcome::Refused(GuardRefused { remote })),
        };

        let manifest_body =
            serde_json::to_vec(manifest).map_err(|error| SyncError::Provider(error.to_string()))?;
        let mut created_collection = false;

        let staged = self
            .put_object(
                &incoming_name(),
                "application/octet-stream",
                blob,
                None,
                &mut created_collection,
            )
            .await?;
        if !staged.status().is_success() {
            return Err(SyncError::from_status(staged.status()));
        }

        let written = self
            .put_object(
                SYNC_MANIFEST_NAME,
                "application/json",
                &manifest_body,
                Some(&precondition),
                &mut created_collection,
            )
            .await?;
        let status = written.status();
        if status == reqwest::StatusCode::PRECONDITION_FAILED {
            // The server refused the precondition, so nothing this push wrote
            // is reachable: the live blob is untouched and the staged bytes go
            // away. Only then is the remote re-read, so the manifest reported
            // to the caller is the one that won.
            self.discard_incoming().await;
            let remote = self.remote_for_refusal().await?;
            return Ok(PutOutcome::Refused(GuardRefused { remote }));
        }
        if !status.is_success() {
            return Err(SyncError::from_status(status));
        }
        // The validator just changed, so the cached one is wrong. Keeping the
        // new one lets a second push follow without another read; losing it
        // costs a read and never a guard.
        self.remember_etag(etag_of(&written));

        let destination = self.child(SYNC_BLOB_NAME)?;
        let moved = self
            .request(dav_method("MOVE"), self.child(&incoming_name())?)
            .header("Destination", destination.as_str())
            // The live blob exists on every push but the first and replacing
            // it is the point; `F` would make every push after the first fail
            // the overwrite rather than the guard.
            .header("Overwrite", "T")
            .send()
            .await
            .map_err(SyncError::from_request)?;
        if !moved.status().is_success() {
            return Err(SyncError::from_status(moved.status()));
        }
        Ok(PutOutcome::Written)
    }

    async fn archive(
        &self,
        suffix: &str,
        blob: &[u8],
        manifest: &SyncManifest,
    ) -> Result<(), SyncError> {
        // Unguarded and additive, per the trait: this runs while a user is
        // resolving a conflict, and an archive write that failed a
        // precondition would strand them with neither side kept. Both names
        // are new on every call, so there is nothing for a guard to protect.
        let mut created_collection = false;
        let written = self
            .put_object(
                &archive_name(suffix),
                "application/octet-stream",
                blob,
                None,
                &mut created_collection,
            )
            .await?;
        if !written.status().is_success() {
            return Err(SyncError::from_status(written.status()));
        }

        // The blob landed first on purpose — see the trait's note. Serialising
        // cannot fail for a struct of numbers and strings, but a `?` here
        // rather than an `expect` keeps a panic out of the conflict-resolution
        // path, which is the last place a user wants one.
        let encoded =
            serde_json::to_vec(manifest).map_err(|error| SyncError::Provider(error.to_string()))?;
        let recorded = self
            .put_object(
                &archive_manifest_name(suffix),
                "application/json",
                &encoded,
                None,
                &mut created_collection,
            )
            .await?;
        if !recorded.status().is_success() {
            return Err(SyncError::from_status(recorded.status()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Arc;

    #[test]
    fn a_plaintext_collection_is_refused() {
        assert!(
            WebDavEngine::new("http://cloud.example.test/dav", "alice", "pw").is_err(),
            "http would put an app password on the wire in the clear"
        );
    }

    #[test]
    fn a_file_url_is_not_a_collection() {
        assert!(WebDavEngine::new("file:///etc/passwd", "alice", "pw").is_err());
    }

    #[test]
    fn an_https_collection_is_accepted() {
        assert!(WebDavEngine::new("https://cloud.example.test/dav", "alice", "pw").is_ok());
    }

    // ── the stub ────────────────────────────────────────────────────────────

    /// One request as the stub saw it on the wire.
    struct Recorded {
        method: String,
        target: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Recorded {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }
    }

    type Journal = Arc<Mutex<Vec<Recorded>>>;

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// A scripted HTTP/1.1 stub: answers each request with the next reply and
    /// records what it was asked.
    ///
    /// `bc-notify`'s RDAP tests serve one request and close, which is not
    /// enough for a push — but this is the same idiom and the same amount of
    /// protocol: enough to satisfy reqwest, with every assertion about
    /// behaviour left to the engine. A request the script did not anticipate
    /// gets a 500 *and* lands in the journal, so an engine that sends an
    /// extra request fails a test loudly instead of hanging it.
    async fn serve(script: Vec<Vec<u8>>) -> (String, Journal) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let journal: Journal = Arc::new(Mutex::new(Vec::new()));
        let replies = Arc::new(Mutex::new(VecDeque::from(script)));

        let recorder = Arc::clone(&journal);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let recorder = Arc::clone(&recorder);
                let replies = Arc::clone(&replies);
                tokio::spawn(async move {
                    let mut buffered: Vec<u8> = Vec::new();
                    loop {
                        let head_end = loop {
                            if let Some(at) = find(&buffered, b"\r\n\r\n") {
                                break at;
                            }
                            let mut chunk = [0u8; 4096];
                            match socket.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(read) => buffered.extend_from_slice(&chunk[..read]),
                            }
                        };

                        let head = String::from_utf8_lossy(&buffered[..head_end]).to_string();
                        let mut lines = head.lines();
                        let request_line = lines.next().unwrap_or_default().to_string();
                        let mut headers = Vec::new();
                        for line in lines {
                            if let Some((key, value)) = line.split_once(':') {
                                headers.push((key.trim().to_string(), value.trim().to_string()));
                            }
                        }
                        let length: usize = headers
                            .iter()
                            .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.parse().ok())
                            .unwrap_or(0);

                        let body_start = head_end + 4;
                        while buffered.len() < body_start + length {
                            let mut chunk = [0u8; 4096];
                            match socket.read(&mut chunk).await {
                                Ok(0) | Err(_) => break,
                                Ok(read) => buffered.extend_from_slice(&chunk[..read]),
                            }
                        }
                        let body_end = (body_start + length).min(buffered.len());
                        let body = buffered[body_start.min(body_end)..body_end].to_vec();
                        buffered.drain(..body_end);

                        let mut parts = request_line.split_whitespace();
                        let method = parts.next().unwrap_or_default().to_string();
                        let target = parts.next().unwrap_or_default().to_string();
                        if let Ok(mut journal) = recorder.lock() {
                            journal.push(Recorded {
                                method,
                                target,
                                headers,
                                body,
                            });
                        }

                        let reply = {
                            let mut queue = match replies.lock() {
                                Ok(queue) => queue,
                                Err(_) => return,
                            };
                            queue.pop_front()
                        };
                        let reply = reply
                            .unwrap_or_else(|| http_reply("500 Internal Server Error", &[], b""));
                        if socket.write_all(&reply).await.is_err() {
                            return;
                        }
                        let _ = socket.flush().await;
                        // A close-delimited reply has to be followed by a
                        // close, or the client waits for a length that is
                        // never coming.
                        if find(&reply, b"Connection: close").is_some() {
                            let _ = socket.shutdown().await;
                            return;
                        }
                    }
                });
            }
        });

        (format!("http://127.0.0.1:{port}/vault/"), journal)
    }

    fn http_reply(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {status}\r\n");
        for (name, value) in headers {
            head.push_str(name);
            head.push_str(": ");
            head.push_str(value);
            head.push_str("\r\n");
        }
        head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        let mut reply = head.into_bytes();
        reply.extend_from_slice(body);
        reply
    }

    /// A reply framed by chunked transfer encoding, which declares no length
    /// at all — the case a `Content-Length` check cannot see.
    fn chunked_reply(status: &str, chunks: &[&[u8]]) -> Vec<u8> {
        let mut reply =
            format!("HTTP/1.1 {status}\r\nTransfer-Encoding: chunked\r\n\r\n").into_bytes();
        for chunk in chunks {
            reply.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            reply.extend_from_slice(chunk);
            reply.extend_from_slice(b"\r\n");
        }
        reply.extend_from_slice(b"0\r\n\r\n");
        reply
    }

    fn engine(base: &str) -> WebDavEngine {
        WebDavEngine::against_test_socket(base, "alice", "app-password")
    }

    fn manifest(generation: u64, blob: &[u8]) -> SyncManifest {
        SyncManifest {
            generation,
            checksum: crate::checksum_hex(blob),
            bytes: blob.len() as u64,
            written_at: "2026-10-09T00:00:00Z".into(),
            device_id: "device-1".into(),
            device_label: "Windows 11".into(),
            payload_version: crate::PAYLOAD_VERSION,
            iterations: 600_000,
            key_length: 32,
            algorithm: "AES-GCM".into(),
        }
    }

    fn manifest_reply(generation: u64, blob: &[u8], etag: &str) -> Vec<u8> {
        let body = serde_json::to_vec(&manifest(generation, blob)).unwrap();
        http_reply(
            "200 OK",
            &[("Content-Type", "application/json"), ("ETag", etag)],
            &body,
        )
    }

    fn target(name: &str) -> String {
        format!("/vault/{name}")
    }

    fn journal_of(journal: &Journal) -> Vec<(String, String)> {
        journal
            .lock()
            .unwrap()
            .iter()
            .map(|request| (request.method.clone(), request.target.clone()))
            .collect()
    }

    // ── probe ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_rejected_app_password_is_unauthorised() {
        let (base, journal) = serve(vec![http_reply("401 Unauthorized", &[], b"")]).await;
        let result = engine(&base).probe().await;

        assert!(
            matches!(result, Err(SyncError::Unauthorised)),
            "a 401 must send the user to their app password: {result:?}"
        );
        let seen = journal.lock().unwrap();
        assert_eq!(seen[0].method, "PROPFIND");
        assert_eq!(seen[0].header("Depth"), Some("0"));
        assert!(
            seen[0]
                .header("Authorization")
                .is_some_and(|value| value.starts_with("Basic ")),
            "the app password travels as HTTP Basic"
        );
    }

    #[tokio::test]
    async fn a_collection_that_does_not_exist_yet_probes_clean() {
        let (base, _) = serve(vec![http_reply("404 Not Found", &[], b"")]).await;
        assert!(
            engine(&base).probe().await.is_ok(),
            "a configured account that has never pushed must test as working; \
             the collection is created by the first push"
        );
    }

    #[tokio::test]
    async fn a_multi_status_is_a_successful_probe() {
        let (base, _) = serve(vec![http_reply(
            "207 Multi-Status",
            &[],
            b"<d:multistatus/>",
        )])
        .await;
        assert!(engine(&base).probe().await.is_ok());
    }

    #[tokio::test]
    async fn an_unusable_answer_to_a_probe_is_a_provider_error() {
        let (base, _) = serve(vec![http_reply("503 Service Unavailable", &[], b"")]).await;
        assert!(matches!(
            engine(&base).probe().await,
            Err(SyncError::Provider(_))
        ));
    }

    // ── reads ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_missing_manifest_is_not_an_error() {
        let (base, journal) = serve(vec![http_reply("404 Not Found", &[], b"")]).await;
        let result = engine(&base).fetch_manifest().await;

        assert!(
            matches!(result, Ok(None)),
            "nothing pushed yet is a state, not a failure: {result:?}"
        );
        assert_eq!(
            journal_of(&journal),
            vec![("GET".into(), target(SYNC_MANIFEST_NAME))]
        );
    }

    #[tokio::test]
    async fn a_manifest_is_read_from_beside_the_blob() {
        let (base, _) = serve(vec![manifest_reply(7, b"sealed", "\"v7\"")]).await;
        let manifest = engine(&base).fetch_manifest().await.unwrap().unwrap();

        assert_eq!(manifest.generation, 7);
        assert!(manifest.describes(b"sealed"));
    }

    #[tokio::test]
    async fn a_manifest_that_will_not_parse_is_corrupt_not_absent() {
        let (base, _) = serve(vec![http_reply("200 OK", &[], b"<html>login</html>")]).await;
        assert!(matches!(
            engine(&base).fetch_manifest().await,
            Err(SyncError::Corrupt)
        ));
    }

    #[tokio::test]
    async fn a_blob_that_was_never_pushed_is_no_remote_blob() {
        let (base, journal) = serve(vec![http_reply("404 Not Found", &[], b"")]).await;
        assert!(matches!(
            engine(&base).fetch_blob().await,
            Err(SyncError::NoRemoteBlob)
        ));
        assert_eq!(
            journal_of(&journal),
            vec![("GET".into(), target(SYNC_BLOB_NAME))]
        );
    }

    #[tokio::test]
    async fn a_blob_comes_back_byte_for_byte() {
        let sealed = b"sealed-envelope-bytes";
        let (base, _) = serve(vec![http_reply("200 OK", &[], sealed)]).await;
        assert_eq!(engine(&base).fetch_blob().await.unwrap(), sealed);
    }

    #[tokio::test]
    async fn an_oversized_blob_is_refused_by_its_declared_length() {
        let declared = MAX_SYNC_ENVELOPE_BYTES + 1;
        let (base, _) = serve(vec![http_reply("200 OK", &[], &vec![b'x'; declared])]).await;
        let result = engine(&base).fetch_blob().await;

        assert!(
            matches!(result, Err(SyncError::TooLarge)),
            "a declared oversized length was accepted: {result:?}"
        );
    }

    /// The length check is the cheap half. A chunked response declares no
    /// length, so the bound that actually holds is the one inside the read
    /// loop — and this is the test that fails if someone removes it.
    #[tokio::test]
    async fn an_oversized_blob_with_no_declared_length_is_refused_while_it_streams() {
        let chunk = vec![b'x'; 32 * 1024];
        let chunks: Vec<&[u8]> = (0..4).map(|_| chunk.as_slice()).collect();
        assert!(
            chunk.len() * 4 > MAX_SYNC_ENVELOPE_BYTES,
            "the fixture has to exceed the bound to test it"
        );
        let (base, _) = serve(vec![chunked_reply("200 OK", &chunks)]).await;
        let result = engine(&base).fetch_blob().await;

        assert!(
            matches!(result, Err(SyncError::TooLarge)),
            "an unbounded chunked body was accepted: {result:?}"
        );
    }

    // ── put ─────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_first_push_requires_the_manifest_to_be_absent() {
        let blob = b"sealed-1";
        let (base, journal) = serve(vec![
            http_reply("201 Created", &[], b""),
            http_reply("201 Created", &[("ETag", "\"v1\"")], b""),
            http_reply("201 Created", &[], b""),
        ])
        .await;

        let outcome = engine(&base)
            .put(blob, &manifest(1, blob), GenerationGuard(None))
            .await
            .unwrap();
        assert!(matches!(outcome, PutOutcome::Written));

        let seen = journal.lock().unwrap();
        assert_eq!(
            seen.iter()
                .map(|r| (r.method.as_str(), r.target.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("PUT", target(&incoming_name()).as_str()),
                ("PUT", target(SYNC_MANIFEST_NAME).as_str()),
                ("MOVE", target(&incoming_name()).as_str()),
            ],
            "the live blob is written by the MOVE and by nothing else"
        );
        assert_eq!(
            seen[1].header("If-None-Match"),
            Some("*"),
            "a first push must be refused if anything is already there"
        );
        assert_eq!(
            seen[1].header("If-Match"),
            None,
            "there is no validator to match on a first push"
        );
        assert_eq!(seen[0].body, blob, "the sealed bytes go up untouched");
        assert!(seen[2]
            .header("Destination")
            .is_some_and(|value| value.ends_with(&target(SYNC_BLOB_NAME))));
        assert_eq!(seen[2].header("Overwrite"), Some("T"));
    }

    #[tokio::test]
    async fn a_later_push_matches_the_validator_the_caller_read() {
        let blob = b"sealed-4";
        let (base, journal) = serve(vec![
            manifest_reply(3, b"sealed-3", "\"v3\""),
            http_reply("201 Created", &[], b""),
            http_reply("204 No Content", &[("ETag", "\"v4\"")], b""),
            http_reply("204 No Content", &[], b""),
        ])
        .await;

        let engine = engine(&base);
        assert_eq!(
            engine.fetch_manifest().await.unwrap().unwrap().generation,
            3
        );
        let outcome = engine
            .put(blob, &manifest(4, blob), GenerationGuard(Some(3)))
            .await
            .unwrap();
        assert!(matches!(outcome, PutOutcome::Written));

        let seen = journal.lock().unwrap();
        assert_eq!(
            seen.len(),
            4,
            "the validator was already in hand: no re-read"
        );
        assert_eq!(
            seen[2].header("If-Match"),
            Some("\"v3\""),
            "the guard is the validator of the manifest the caller compared against"
        );
        assert_eq!(seen[2].header("If-None-Match"), None);
    }

    /// The test this file exists for. A guard that loses must leave the live
    /// blob exactly as it was, take the staged bytes away, and hand back the
    /// manifest that won — and the only way to know it did is to look at what
    /// the server was asked, not at what the function returned.
    #[tokio::test]
    async fn a_refused_guard_writes_nothing_and_cleans_up_after_itself() {
        let blob = b"sealed-4";
        let (base, journal) = serve(vec![
            // What this device compared against, and the validator it guards
            // with.
            manifest_reply(3, b"sealed-3", "\"v3\""),
            // Staged.
            http_reply("201 Created", &[], b""),
            // The other device got there first, and the server says so.
            http_reply("412 Precondition Failed", &[], b""),
            // The staged bytes go away.
            http_reply("204 No Content", &[], b""),
            // What the remote actually holds now.
            manifest_reply(9, b"sealed-9", "\"v9\""),
        ])
        .await;

        let engine = engine(&base);
        assert_eq!(
            engine.fetch_manifest().await.unwrap().unwrap().generation,
            3
        );
        let outcome = engine
            .put(blob, &manifest(4, blob), GenerationGuard(Some(3)))
            .await
            .unwrap();

        let PutOutcome::Refused(refused) = outcome else {
            panic!("a lost guard must refuse, not write: {outcome:?}");
        };
        assert_eq!(
            refused.remote.generation, 9,
            "the refusal carries the manifest that won, so the UI can describe the conflict"
        );
        assert!(refused.remote.describes(b"sealed-9"));

        let seen = journal.lock().unwrap();
        assert_eq!(
            seen.iter()
                .map(|r| (r.method.as_str(), r.target.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("GET", target(SYNC_MANIFEST_NAME).as_str()),
                ("PUT", target(&incoming_name()).as_str()),
                ("PUT", target(SYNC_MANIFEST_NAME).as_str()),
                ("DELETE", target(&incoming_name()).as_str()),
                ("GET", target(SYNC_MANIFEST_NAME).as_str()),
            ]
        );
        assert_eq!(
            seen[2].header("If-Match"),
            Some("\"v3\""),
            "the 412 has to have been the guard being enforced, not some other precondition"
        );
        assert!(
            !seen
                .iter()
                .any(|request| request.target == target(SYNC_BLOB_NAME)),
            "no request may address the live blob on a refused push"
        );
        assert!(
            !seen.iter().any(|request| request.method == "MOVE"),
            "nothing may be moved into place once the guard has been refused"
        );
    }

    /// A `put` with no preceding `fetch_manifest` has no validator, so it
    /// reads one — and then it is the generation, not the validator, that
    /// decides, because a validator read a moment ago would match a manifest
    /// the caller never saw.
    #[tokio::test]
    async fn a_push_with_no_validator_in_hand_checks_the_generation_itself() {
        let blob = b"sealed-4";
        let (base, journal) = serve(vec![manifest_reply(9, b"sealed-9", "\"v9\"")]).await;

        let outcome = engine(&base)
            .put(blob, &manifest(4, blob), GenerationGuard(Some(3)))
            .await
            .unwrap();

        let PutOutcome::Refused(refused) = outcome else {
            panic!("a moved remote must refuse: {outcome:?}");
        };
        assert_eq!(refused.remote.generation, 9);
        assert_eq!(
            journal_of(&journal),
            vec![("GET".into(), target(SYNC_MANIFEST_NAME))],
            "a guard that has already lost must not upload or stage anything"
        );
    }

    // ── the collection ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_missing_collection_is_created_once() {
        let blob = b"sealed-1";
        let (base, journal) = serve(vec![
            http_reply("409 Conflict", &[], b""),
            http_reply("201 Created", &[], b""),
            http_reply("201 Created", &[], b""),
            http_reply("201 Created", &[("ETag", "\"v1\"")], b""),
            http_reply("201 Created", &[], b""),
        ])
        .await;

        let outcome = engine(&base)
            .put(blob, &manifest(1, blob), GenerationGuard(None))
            .await
            .unwrap();
        assert!(matches!(outcome, PutOutcome::Written));

        let seen = journal.lock().unwrap();
        assert_eq!(
            seen.iter().filter(|r| r.method == "MKCOL").count(),
            1,
            "the collection is created once per push, not once per PUT"
        );
        assert_eq!(seen[1].method, "MKCOL");
        assert_eq!(seen[1].target, "/vault/");
    }

    /// A server that answers the retry the same way gets its answer returned.
    /// Retrying until it changes its mind is how a push becomes a loop.
    #[tokio::test]
    async fn a_collection_that_cannot_be_created_is_not_retried_forever() {
        let blob = b"sealed-1";
        let (base, journal) = serve(vec![
            http_reply("409 Conflict", &[], b""),
            http_reply("201 Created", &[], b""),
            http_reply("409 Conflict", &[], b""),
        ])
        .await;

        let result = engine(&base)
            .put(blob, &manifest(1, blob), GenerationGuard(None))
            .await;
        assert!(
            matches!(result, Err(SyncError::Provider(_))),
            "the second refusal is the answer: {result:?}"
        );
        let seen = journal.lock().unwrap();
        assert_eq!(seen.iter().filter(|r| r.method == "MKCOL").count(), 1);
        assert_eq!(seen.len(), 3, "one PUT, one MKCOL, one retry, and no more");
    }

    /// The staged blob and the manifest are two `PUT`s, so "create the
    /// collection once" has to mean once per *push* and not once per `PUT`.
    /// This is the interleaving where the difference shows: the collection is
    /// created for the staged write and is gone again by the manifest write,
    /// which is a server-side state this engine cannot fix by creating it a
    /// second time — so it reports the status instead of trying.
    #[tokio::test]
    async fn a_collection_that_vanishes_mid_push_is_not_created_twice() {
        let blob = b"sealed-1";
        let (base, journal) = serve(vec![
            http_reply("409 Conflict", &[], b""),
            http_reply("201 Created", &[], b""),
            http_reply("201 Created", &[], b""),
            // Gone again, between the staged write and the manifest write.
            http_reply("409 Conflict", &[], b""),
        ])
        .await;

        let result = engine(&base)
            .put(blob, &manifest(1, blob), GenerationGuard(None))
            .await;
        assert!(
            matches!(result, Err(SyncError::Provider(_))),
            "the second 409 is the answer: {result:?}"
        );
        let seen = journal.lock().unwrap();
        assert_eq!(
            seen.iter().filter(|r| r.method == "MKCOL").count(),
            1,
            "a push creates the collection at most once, however many PUTs it makes"
        );
        assert_eq!(seen.len(), 4, "and sends nothing after the second refusal");
    }

    #[tokio::test]
    async fn a_collection_that_already_exists_is_not_an_error() {
        let blob = b"sealed-1";
        let (base, _) = serve(vec![
            http_reply("404 Not Found", &[], b""),
            http_reply("405 Method Not Allowed", &[], b""),
            http_reply("201 Created", &[], b""),
            http_reply("201 Created", &[("ETag", "\"v1\"")], b""),
            http_reply("201 Created", &[], b""),
        ])
        .await;

        assert!(matches!(
            engine(&base)
                .put(blob, &manifest(1, blob), GenerationGuard(None))
                .await,
            Ok(PutOutcome::Written)
        ));
    }

    // ── archive ─────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn an_archive_is_unguarded_and_additive() {
        let discarded = b"the-side-the-user-did-not-keep";
        let (base, journal) = serve(vec![
            http_reply("201 Created", &[], b""),
            http_reply("201 Created", &[], b""),
        ])
        .await;

        engine(&base)
            .archive("2026-10-09T101500Z", discarded, &manifest(7, discarded))
            .await
            .unwrap();

        let seen = journal.lock().unwrap();
        assert_eq!(
            seen.iter()
                .map(|r| (r.method.as_str(), r.target.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (
                    "PUT",
                    target("better-cloudflare-vault.2026-10-09T101500Z.enc").as_str()
                ),
                (
                    "PUT",
                    target("better-cloudflare-vault.2026-10-09T101500Z.json").as_str()
                ),
            ],
            "an archive is two new objects beside the live blob, never over it,              and the blob is written before the manifest that describes it"
        );
        assert_eq!(seen[0].body, discarded);
        for request in seen.iter() {
            assert_eq!(
                request.header("If-Match"),
                None,
                "a precondition on an archive is a way to strand someone mid-resolution"
            );
            assert_eq!(request.header("If-None-Match"), None);
        }
    }

    /// The archived manifest is what makes the archived blob openable: a
    /// sealed envelope does not record its own iteration count, so an archive
    /// without these three fields is bytes nobody can ever decrypt.
    #[tokio::test]
    async fn an_archived_blob_keeps_the_parameters_needed_to_open_it() {
        let discarded = b"the-side-the-user-did-not-keep";
        let (base, journal) = serve(vec![
            http_reply("201 Created", &[], b""),
            http_reply("201 Created", &[], b""),
        ])
        .await;

        engine(&base)
            .archive("2026-10-09T101500Z", discarded, &manifest(7, discarded))
            .await
            .unwrap();

        let seen = journal.lock().unwrap();
        let recorded: SyncManifest =
            serde_json::from_slice(&seen[1].body).expect("the archived manifest must be readable");
        assert_eq!(recorded.generation, 7);
        assert_eq!(recorded.checksum, crate::checksum_hex(discarded));
        assert_eq!(recorded.iterations, manifest(7, discarded).iterations);
        assert_eq!(recorded.key_length, manifest(7, discarded).key_length);
        assert_eq!(recorded.algorithm, manifest(7, discarded).algorithm);
        assert!(
            recorded.describes(discarded),
            "the archived manifest must describe the bytes archived beside it"
        );
    }

    /// Both writes must land before the caller discards a side, so a failure
    /// on the second is an error and not a silent half-archive.
    #[tokio::test]
    async fn a_failed_manifest_write_fails_the_whole_archive() {
        let discarded = b"the-side-the-user-did-not-keep";
        let (base, _journal) = serve(vec![
            http_reply("201 Created", &[], b""),
            http_reply("507 Insufficient Storage", &[], b""),
        ])
        .await;

        let result = engine(&base)
            .archive("2026-10-09T101500Z", discarded, &manifest(7, discarded))
            .await;
        assert!(
            result.is_err(),
            "a blob archived without its manifest must not report success"
        );
    }

    /// The suffix reaches this engine from the command layer, and a name built
    /// by interpolation is a name someone can put a `/` in. Percent-encoding
    /// the segment is what keeps it from addressing anything else.
    #[tokio::test]
    async fn an_archive_suffix_cannot_address_another_collection() {
        let (base, journal) = serve(vec![
            http_reply("201 Created", &[], b""),
            http_reply("201 Created", &[], b""),
        ])
        .await;

        engine(&base)
            .archive("../../escaped", b"x", &manifest(1, b"x"))
            .await
            .unwrap();

        let seen = journal.lock().unwrap();
        assert_eq!(
            seen[0].target, "/vault/better-cloudflare-vault...%2F..%2Fescaped.enc",
            "the suffix stayed inside one path segment"
        );
        assert!(!seen[0].target.contains("/vault/../"));
    }
}
