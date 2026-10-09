//! The Google Drive engine, over the Drive v3 REST API.
//!
//! # It takes a token, and does not obtain one
//!
//! There is no OAuth flow here, and that is a decision rather than an
//! omission: a desktop OAuth client cannot keep a client secret, because the
//! secret ships inside a binary anyone can unzip — and this repository is
//! public, so it would ship in the source too. `bc_registrar::google` already
//! made this call for Google Cloud Domains, taking a pre-obtained
//! `access_token` and `bearer_auth`ing it, and this engine follows it.
//!
//! The cost is honest and visible: the user pastes a credential they obtained
//! themselves, and a short-lived access token will expire. That is why the
//! settings screen names Nextcloud as the better-supported option rather than
//! presenting the two as equals. An expired token arrives here as a `401` and
//! leaves as [`SyncError::Unauthorised`], which is the one failure this engine
//! produces that the user can only fix by pasting a new credential.
//!
//! # `appDataFolder`, not `My Drive`
//!
//! The blob goes in the application data folder, which is per-app, hidden from
//! the Drive UI, and reachable only with the `drive.appdata` scope. A vault
//! sitting in `My Drive` is a vault someone shares into a folder by accident.
//! Every request below carries `spaces=appDataFolder`, including the ones that
//! would work without it: a request that omits it is a request that reads or
//! writes the user's real Drive.
//!
//! # The guard is weaker here, and the code says so
//!
//! Drive offers no `If-Match` equivalent on an `appDataFolder` upload, so the
//! guard is a read-then-write with the window made as small as possible, and
//! the manifest re-read immediately before the upload. That is genuinely
//! weaker than WebDAV's server-side precondition, and the race it leaves is
//! narrow but real: two devices pushing within the same few hundred
//! milliseconds can still have one overwrite the other.
//!
//! The window is one request wide rather than one operation wide, which is the
//! only thing this file can do about it: the blob's file id is looked up
//! *before* the guard read, so between the manifest the guard checked and the
//! first byte of the upload there is nothing but the check itself.
//!
//! What the remaining race costs is worth stating exactly, because it is
//! tempting to believe the archive copy covers it. It does not.
//! [`SyncEngine::archive`] is written when the *user* resolves a conflict, and
//! a write that loses this race produces no conflict for anyone to resolve —
//! the losing blob is replaced and nothing records that it existed. So the
//! honest summary is that this guard catches every divergence it can see one
//! request earlier, and nothing inside the round-trip it cannot see into.
//! Nextcloud is the recommended provider for that reason and not as a matter
//! of taste.
//!
//! # Drive does not keep names unique
//!
//! `files.list` can legitimately answer with two files called
//! `better-cloudflare-vault.enc`, because Drive has no uniqueness constraint
//! on a name within a folder. So a lost race here can leave a duplicate rather
//! than an overwrite. This takes the first match and leans on the manifest
//! checksum to refuse a mismatched pair, which turns that case into a
//! `corrupt` the user can push over rather than a silently wrong restore.

use std::time::Duration;

use serde::Deserialize;

use crate::{
    checksum_hex, GenerationGuard, GuardRefused, PutOutcome, SyncEngine, SyncError, SyncManifest,
    MAX_SYNC_ENVELOPE_BYTES, SYNC_BLOB_NAME, SYNC_MANIFEST_NAME,
};

/// Scheme and authority of the Drive API. Both the metadata endpoints
/// (`/drive/v3`) and the upload endpoints (`/upload/drive/v3`) live under it,
/// so one override is enough to point the whole engine somewhere else.
const DRIVE_API_BASE: &str = "https://www.googleapis.com";

/// The reserved parent id for an app's own hidden folder.
const APP_DATA_FOLDER: &str = "appDataFolder";

/// Restated per client so a stalled connection cannot wedge a push: the
/// payload is bounded at 96 KiB in both directions, so a request that has not
/// finished in thirty seconds is not going to finish.
const DRIVE_TIMEOUT: Duration = Duration::from_secs(30);

/// A configured Drive target.
pub struct GoogleDriveEngine {
    client: reqwest::Client,
    access_token: String,
    /// Where the API lives, without a trailing slash. See
    /// [`GoogleDriveEngine::with_base_url`].
    base: String,
}

impl GoogleDriveEngine {
    pub fn new(access_token: &str) -> Result<Self, SyncError> {
        Self::with_base_url(access_token, DRIVE_API_BASE)
    }

    /// The same engine against a different origin, so the tests can serve it
    /// from a local socket.
    ///
    /// Deliberately private, and the reason is not tidiness: this is the one
    /// place an access token could be aimed at an arbitrary host over plain
    /// HTTP. [`GoogleDriveEngine::new`] passes the constant, nothing else can
    /// pass anything, and so there is no scheme check to forget — unlike
    /// `WebDavEngine::new`, which takes its URL from the settings store and
    /// has to refuse `http://` itself.
    fn with_base_url(access_token: &str, base: &str) -> Result<Self, SyncError> {
        if access_token.trim().is_empty() {
            return Err(SyncError::NotConfigured);
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(DRIVE_TIMEOUT)
                .build()
                .map_err(|error| SyncError::Unreachable(error.to_string()))?,
            access_token: access_token.to_string(),
            base: base.trim_end_matches('/').to_string(),
        })
    }

    /// Build a URL under the API, appending `id` as a path segment so that an
    /// id which is not the `[A-Za-z0-9_-]` Drive documents cannot walk out of
    /// the path, and percent-encoding the parameters so a file name cannot
    /// smuggle one.
    fn api_url(
        &self,
        path: &str,
        id: Option<&str>,
        params: &[(&str, &str)],
    ) -> Result<url::Url, SyncError> {
        let mut url = url::Url::parse(&format!("{}{path}", self.base))
            .map_err(|error| SyncError::Unreachable(error.to_string()))?;
        if let Some(id) = id {
            url.path_segments_mut()
                .map_err(|_| SyncError::Unreachable("the Drive base URL cannot be a base".into()))?
                .push(id);
        }
        url.query_pairs_mut().extend_pairs(params.iter());
        Ok(url)
    }

    async fn get(&self, url: &url::Url) -> Result<reqwest::Response, SyncError> {
        self.client
            .get(url.as_str())
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(SyncError::from_request)
    }

    /// The first file in the app data folder with this exact name, if any.
    async fn find_file(&self, name: &str) -> Result<Option<DriveFile>, SyncError> {
        let url = self.api_url(
            "/drive/v3/files",
            None,
            &[
                ("spaces", APP_DATA_FOLDER),
                ("q", &format!("name='{}'", escape_query_value(name))),
                ("fields", "files(id,name,size)"),
            ],
        )?;
        let response = self.get(&url).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(not_a_missing_object(status));
        }
        let body = read_bounded(response).await?;
        let listing: FileList = serde_json::from_slice(&body)
            .map_err(|_| SyncError::Provider("unreadable Drive file listing".into()))?;
        // See the module header on duplicate names: the first match, and the
        // checksum catches a blob the manifest does not describe.
        Ok(listing.files.into_iter().next())
    }

    /// Download one file by id. `None` when it has gone since it was listed,
    /// which is a remote that is now empty rather than an error.
    async fn download(&self, file: &DriveFile) -> Result<Option<Vec<u8>>, SyncError> {
        // A size Drive has already reported costs nothing to refuse before the
        // transfer, and the field is asked for anyway. It is not a substitute
        // for the bound inside `read_bounded`: Drive omits `size` for some
        // files, and nothing says the download has to agree with the listing.
        if let Some(size) = file
            .size
            .as_deref()
            .and_then(|size| size.parse::<u64>().ok())
        {
            if size > MAX_SYNC_ENVELOPE_BYTES as u64 {
                return Err(SyncError::TooLarge);
            }
        }
        let url = self.api_url("/drive/v3/files", Some(&file.id), &[("alt", "media")])?;
        let response = self.get(&url).await?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(SyncError::from_status(status));
        }
        Ok(Some(read_bounded(response).await?))
    }

    /// The manifest and the file holding it, so a caller that is about to
    /// replace it already has the id and does not spend another request — and
    /// another slice of the guard's window — finding it again.
    async fn read_manifest(&self) -> Result<Option<(DriveFile, SyncManifest)>, SyncError> {
        let Some(file) = self.find_file(SYNC_MANIFEST_NAME).await? else {
            return Ok(None);
        };
        let Some(body) = self.download(&file).await? else {
            return Ok(None);
        };
        let text = String::from_utf8(body).map_err(|_| SyncError::Corrupt)?;
        Ok(Some((file, SyncManifest::parse(&text)?)))
    }

    /// Create or replace one object, metadata and bytes in one request.
    ///
    /// `uploadType=multipart` rather than `resumable`: the payload is bounded
    /// at 96 KiB, so a resumable session would be two extra round-trips spent
    /// making a single small request restartable — and every extra round-trip
    /// inside `put` is the generation guard's window held open for longer.
    async fn upload(
        &self,
        name: &str,
        media: &[u8],
        existing: Option<&str>,
    ) -> Result<(), SyncError> {
        let metadata = match existing {
            // `parents` is only accepted on a create. Drive refuses a parent
            // change on an update and wants `addParents`/`removeParents`
            // instead, and the file is already in the right folder.
            Some(_) => serde_json::json!({ "name": name }),
            None => serde_json::json!({ "name": name, "parents": [APP_DATA_FOLDER] }),
        };
        let boundary = format!("bc-sync-{}", checksum_hex(media));
        let body = multipart_related(&boundary, &metadata.to_string(), media)?;

        let url = match existing {
            Some(id) => self.api_url(
                "/upload/drive/v3/files",
                Some(id),
                &[("uploadType", "multipart")],
            )?,
            None => self.api_url(
                "/upload/drive/v3/files",
                None,
                &[("uploadType", "multipart")],
            )?,
        };
        let request = match existing {
            Some(_) => self.client.patch(url.as_str()),
            None => self.client.post(url.as_str()),
        };

        let response = request
            .bearer_auth(&self.access_token)
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/related; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(SyncError::from_request)?;
        let status = response.status();
        if !status.is_success() {
            return Err(not_a_missing_object(status));
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl SyncEngine for GoogleDriveEngine {
    async fn probe(&self) -> Result<(), SyncError> {
        let url = self.api_url(
            "/drive/v3/files",
            None,
            &[
                ("spaces", APP_DATA_FOLDER),
                ("pageSize", "1"),
                ("fields", "files(id)"),
            ],
        )?;
        let response = self.get(&url).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(not_a_missing_object(status));
        }
        // The body is deliberately not read. An empty app data folder is a
        // configured account that has never pushed, and the trait requires
        // that to probe clean — the credential is what this is testing.
        Ok(())
    }

    async fn fetch_manifest(&self) -> Result<Option<SyncManifest>, SyncError> {
        Ok(self.read_manifest().await?.map(|(_, manifest)| manifest))
    }

    async fn fetch_blob(&self) -> Result<Vec<u8>, SyncError> {
        let Some(file) = self.find_file(SYNC_BLOB_NAME).await? else {
            return Err(SyncError::NoRemoteBlob);
        };
        self.download(&file).await?.ok_or(SyncError::NoRemoteBlob)
    }

    async fn put(
        &self,
        blob: &[u8],
        manifest: &SyncManifest,
        guard: GenerationGuard,
    ) -> Result<PutOutcome, SyncError> {
        // Before the guard read, not after: this lookup tells us whether the
        // blob is a create or a replace, and it has nothing to do with what
        // the guard is checking. Doing it first is the difference between a
        // window one request wide and one two requests wide.
        let blob_file = self.find_file(SYNC_BLOB_NAME).await?;

        // The guard read, as late as it can be put.
        let remote = self.read_manifest().await?;

        match (guard.0, &remote) {
            // `None` means the caller believes nothing is there. Anything at
            // all is another device's vault.
            (None, Some((_, remote_manifest))) => {
                return Ok(PutOutcome::Refused(GuardRefused {
                    remote: remote_manifest.clone(),
                }));
            }
            // `Some(n)`: the remote must still be at exactly `n`. Higher is
            // the ordinary case — another device pushed — and lower means this
            // device is reading a remote that was rolled back, which is just
            // as much a divergence and just as much a refusal.
            (Some(expected), Some((_, remote_manifest))) => {
                if remote_manifest.generation != expected {
                    return Ok(PutOutcome::Refused(GuardRefused {
                        remote: remote_manifest.clone(),
                    }));
                }
            }
            // `Some(n)` against an empty remote: the vault this device expected
            // to replace has been deleted. Strictly the guard does not hold,
            // but `GuardRefused` carries a `SyncManifest` and not an
            // `Option<SyncManifest>`, so there is no way to report the refusal
            // without inventing a remote manifest for the UI to display — and
            // refusing would wedge the user, since every later push would
            // refuse identically until they reconfigured. Writing where
            // nothing is cannot lose anyone's keys, so this creates. The cost
            // is that a deliberate remote wipe is undone by the next push.
            (Some(_), None) => {}
            (None, None) => {}
        }

        let manifest_body = serde_json::to_vec(manifest)
            // Cannot fail for this struct; mapped rather than unwrapped
            // because a panic in an engine takes the command with it.
            .map_err(|_| SyncError::Provider("the manifest could not be serialised".into()))?;

        // Blob first. If the second upload fails the remote holds a new blob
        // described by an old manifest, which a pull refuses as `corrupt`
        // through `SyncManifest::describes` — and a repeat push repairs it,
        // because the generation the guard reads is still the old one the
        // caller expected. The other order would leave a manifest pointing at
        // bytes that were never uploaded.
        self.upload(
            SYNC_BLOB_NAME,
            blob,
            blob_file.as_ref().map(|file| file.id.as_str()),
        )
        .await?;
        self.upload(
            SYNC_MANIFEST_NAME,
            &manifest_body,
            remote.as_ref().map(|(file, _)| file.id.as_str()),
        )
        .await?;
        Ok(PutOutcome::Written)
    }

    async fn archive(
        &self,
        suffix: &str,
        blob: &[u8],
        manifest: &SyncManifest,
    ) -> Result<(), SyncError> {
        // Named off the blob constant so the two cannot drift apart.
        let stem = SYNC_BLOB_NAME
            .strip_suffix(".enc")
            .unwrap_or(SYNC_BLOB_NAME);
        // No lookup on either write: an archive is additive, so there is
        // nothing to replace, and the trait is explicit that this must not be
        // the call that fails and strands a half-resolved conflict. A second
        // archive under the same suffix lands beside the first rather than
        // over it, which is the harmless direction for this to fail in.
        //
        // The blob goes first, per the trait: a manifest describing bytes that
        // never arrived is worse than bytes whose parameters have to be read
        // off a sibling archive.
        self.upload(&format!("{stem}.{suffix}.enc"), blob, None)
            .await?;

        // `.json`, not `.enc` — this is the plaintext record of the parameters
        // the envelope was sealed with, and a `.enc` extension on readable
        // JSON invites someone to try to decrypt it. Serialising a struct of
        // numbers and strings cannot fail, but a `?` keeps a panic out of the
        // conflict-resolution path.
        let encoded =
            serde_json::to_vec(manifest).map_err(|error| SyncError::Provider(error.to_string()))?;
        self.upload(&format!("{stem}.{suffix}.json"), &encoded, None)
            .await
    }
}

/// One entry from a `files.list` response.
#[derive(Debug, Deserialize)]
struct DriveFile {
    id: String,
    /// Drive reports a byte count as a decimal **string**, because the field
    /// is an int64 and JSON has no such number. It is absent for anything
    /// without a byte count of its own, so this is an `Option`.
    #[serde(default)]
    size: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileList {
    #[serde(default)]
    files: Vec<DriveFile>,
}

/// Escape a value going into a Drive `q` expression.
///
/// Drive's query language quotes a string with `'`, and documents `\'` as the
/// escape. Every name this engine looks up today is a constant, so this
/// protects against nothing that exists — but [`GoogleDriveEngine::find_file`]
/// takes a `&str`, and the next caller to pass something a user typed would
/// otherwise be closing the quote for them.
fn escape_query_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

/// A `multipart/related` body: the file's metadata, then its bytes.
///
/// The boundary callers pass is derived from a digest of the media, which is
/// why nothing here needs a random number generator — a body cannot contain a
/// string that contains that body's own SHA-256. That is an argument, though,
/// and MIME has no recovery from a boundary that appears inside a part, so the
/// scan below makes it a checked property instead. It costs one pass over at
/// most 96 KiB.
fn multipart_related(boundary: &str, metadata: &str, media: &[u8]) -> Result<Vec<u8>, SyncError> {
    let marker = format!("--{boundary}");
    let collides = metadata.contains(&marker)
        || media
            .windows(marker.len())
            .any(|window| window == marker.as_bytes());
    if collides {
        return Err(SyncError::Provider(
            "the multipart boundary collided with the payload".into(),
        ));
    }

    let head = format!(
        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n\
         --{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n"
    );
    let tail = format!("\r\n--{boundary}--\r\n");
    let mut body = Vec::with_capacity(head.len() + media.len() + tail.len());
    body.extend_from_slice(head.as_bytes());
    body.extend_from_slice(media);
    body.extend_from_slice(tail.as_bytes());
    Ok(body)
}

/// [`SyncError::from_status`] is this crate's one classifier, and its
/// `404` → [`SyncError::NoRemoteBlob`] arm is about fetching an *object*.
/// Two paths here cannot be talking about one: a probe asks for a listing, and
/// an upload addresses a file id the listing just handed over. Reporting
/// "nothing has been pushed yet" from either would send the user to a pull
/// they cannot do, so that single arm is restated as what it actually is on
/// these paths — an endpoint that answered 404.
fn not_a_missing_object(status: reqwest::StatusCode) -> SyncError {
    match SyncError::from_status(status) {
        SyncError::NoRemoteBlob => SyncError::Provider(format!("HTTP {}", status.as_u16())),
        other => other,
    }
}

/// Read a response body, refusing one over [`MAX_SYNC_ENVELOPE_BYTES`] *while*
/// it arrives.
///
/// `Content-Length` is checked where there is one, and the streamed read is
/// bounded whether or not there was: a chunked response declares no length, so
/// the declared-length check alone would let a remote hand this process as
/// many bytes as it liked. Same shape, and the same reasoning, as
/// `bc_notify::rdap::fetch_rdap_document`.
async fn read_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, SyncError> {
    if let Some(length) = response.content_length() {
        if length > MAX_SYNC_ENVELOPE_BYTES as u64 {
            return Err(SyncError::TooLarge);
        }
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(SyncError::from_request)? {
        if body.len() + chunk.len() > MAX_SYNC_ENVELOPE_BYTES {
            return Err(SyncError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const BLOB_ID: &str = "blob-id";
    const MANIFEST_ID: &str = "manifest-id";

    #[test]
    fn a_blank_token_is_not_configured() {
        assert!(GoogleDriveEngine::new("").is_err());
        assert!(GoogleDriveEngine::new("   ").is_err());
    }

    #[test]
    fn a_token_is_accepted_without_being_validated_here() {
        // Validity is the endpoint's to judge; this only refuses an empty
        // field, so that "connected" never means "a blank string was saved".
        assert!(GoogleDriveEngine::new("ya29.example").is_ok());
    }

    #[test]
    fn a_quote_in_a_name_cannot_close_the_query() {
        assert_eq!(escape_query_value("it's"), "it\\'s");
        assert_eq!(escape_query_value("back\\slash"), "back\\\\slash");
        assert_eq!(escape_query_value(SYNC_BLOB_NAME), SYNC_BLOB_NAME);
    }

    #[test]
    fn a_boundary_that_appears_in_the_payload_is_refused() {
        // Unreachable with a digest-derived boundary, which is exactly why it
        // is worth pinning: the check is the thing that makes "unreachable"
        // true rather than hoped for.
        assert!(multipart_related("x", "{}", b"before --x after").is_err());
        assert!(multipart_related("x", "{\"name\":\"--x\"}", b"body").is_err());
        assert!(multipart_related("x", "{}", b"body").is_ok());
    }

    // ── a stub Drive, on a real socket ───────────────────────────────────────

    /// One request the stub answered.
    ///
    /// Kept so a test can assert on what the engine *did* rather than only on
    /// what it returned: a guard that reports `Refused` having already
    /// uploaded is the defect this file most needs to catch, and a return
    /// value cannot see it.
    #[derive(Clone)]
    struct Seen {
        method: String,
        target: String,
        head: String,
        body: Vec<u8>,
    }

    /// Written by hand because the derive prints a body as a list of byte
    /// values, and every assertion in this module that fails prints a request.
    impl std::fmt::Debug for Seen {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "{} {}", self.method, self.target)?;
            if !self.body.is_empty() {
                write!(formatter, " {:?}", self.body_text())?;
            }
            Ok(())
        }
    }

    impl Seen {
        fn path(&self) -> &str {
            self.target.split('?').next().unwrap_or_default()
        }

        /// A query parameter, decoded — which also means every assertion on
        /// one is an assertion that the engine encoded it correctly.
        fn param(&self, key: &str) -> Option<String> {
            let (_, query) = self.target.split_once('?')?;
            url::form_urlencoded::parse(query.as_bytes())
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.into_owned())
        }

        fn header(&self, name: &str) -> Option<String> {
            self.head.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case(name)
                    .then(|| value.trim().to_string())
            })
        }

        fn body_text(&self) -> String {
            String::from_utf8_lossy(&self.body).into_owned()
        }

        fn is_upload(&self) -> bool {
            self.path().starts_with("/upload/")
        }
    }

    struct Stub {
        base: String,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    impl Stub {
        fn engine(&self, token: &str) -> GoogleDriveEngine {
            GoogleDriveEngine::with_base_url(token, &self.base).unwrap()
        }

        fn seen(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }

        fn uploads(&self) -> Vec<Seen> {
            self.seen().into_iter().filter(Seen::is_upload).collect()
        }
    }

    /// An HTTP/1.1 stub that answers every request through `handler` and
    /// records it.
    ///
    /// The one-shot socket from `bc-notify`'s RDAP tests, kept up for a whole
    /// operation instead: `put` is a sequence of requests, and the sequence is
    /// most of what is under test here. Keep-alive is honoured, so the
    /// recorded order is the order the engine issued them in.
    async fn serve<F>(handler: F) -> Stub
    where
        F: Fn(&Seen) -> Vec<u8> + Send + Sync + 'static,
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        let handler = Arc::new(handler);

        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let recorder = Arc::clone(&recorder);
                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    let mut buffered: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        let head_end = loop {
                            if let Some(index) = find(&buffered, b"\r\n\r\n") {
                                break Some(index + 4);
                            }
                            match socket.read(&mut chunk).await {
                                Ok(0) | Err(_) => break None,
                                Ok(read) => buffered.extend_from_slice(&chunk[..read]),
                            }
                        };
                        let Some(head_end) = head_end else { return };
                        let head = String::from_utf8_lossy(&buffered[..head_end]).into_owned();
                        let length = content_length(&head);
                        while buffered.len() < head_end + length {
                            match socket.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(read) => buffered.extend_from_slice(&chunk[..read]),
                            }
                        }
                        let mut start = head.lines().next().unwrap_or_default().split(' ');
                        let request = Seen {
                            method: start.next().unwrap_or_default().to_string(),
                            target: start.next().unwrap_or_default().to_string(),
                            head: head.clone(),
                            body: buffered[head_end..head_end + length].to_vec(),
                        };
                        buffered.drain(..head_end + length);
                        let response = handler(&request);
                        recorder.lock().unwrap().push(request);
                        if socket.write_all(&response).await.is_err() {
                            return;
                        }
                        let _ = socket.flush().await;
                    }
                });
            }
        });

        Stub {
            base: format!("http://127.0.0.1:{port}"),
            seen,
        }
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn content_length(head: &str) -> usize {
        for line in head.lines() {
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    return value.trim().parse().unwrap_or(0);
                }
            }
        }
        0
    }

    fn response(status: u16, reason: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    fn ok_json(body: &str) -> Vec<u8> {
        response(200, "OK", "application/json", body.as_bytes())
    }

    fn ok_bytes(body: &[u8]) -> Vec<u8> {
        response(200, "OK", "application/octet-stream", body)
    }

    fn refusal(status: u16, reason: &str) -> Vec<u8> {
        response(status, reason, "application/json", b"{}")
    }

    /// A body in chunks, with no `Content-Length` to inspect.
    fn chunked(body: &[u8]) -> Vec<u8> {
        let mut bytes =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
                .to_vec();
        for piece in body.chunks(8192) {
            bytes.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
            bytes.extend_from_slice(piece);
            bytes.extend_from_slice(b"\r\n");
        }
        bytes.extend_from_slice(b"0\r\n\r\n");
        bytes
    }

    fn file_list(entries: &[(&str, &str, usize)]) -> String {
        let files: Vec<serde_json::Value> = entries
            .iter()
            .map(|(id, name, size)| {
                serde_json::json!({
                    "id": id,
                    "name": name,
                    // A string, as Drive sends it. Parsing that is under test.
                    "size": size.to_string(),
                })
            })
            .collect();
        serde_json::json!({ "files": files }).to_string()
    }

    fn manifest_for(blob: &[u8], generation: u64) -> SyncManifest {
        SyncManifest {
            generation,
            checksum: checksum_hex(blob),
            bytes: blob.len() as u64,
            written_at: "2026-02-03T04:05:06Z".into(),
            device_id: "device-1".into(),
            device_label: "Windows 11".into(),
            payload_version: crate::PAYLOAD_VERSION,
            iterations: 600_000,
            key_length: 32,
            algorithm: "AES-GCM".into(),
        }
    }

    /// What a stubbed app data folder holds. A test describes the remote and
    /// one handler answers the whole sequence, so a test that expects *no*
    /// upload never has to script one — an unexpected request answers 500 and
    /// surfaces as a `provider-error` rather than passing quietly.
    #[derive(Clone)]
    struct Remote {
        blob: Option<Vec<u8>>,
        manifest: Option<String>,
    }

    impl Remote {
        fn empty() -> Self {
            Self {
                blob: None,
                manifest: None,
            }
        }

        /// A remote holding `blob` at `generation`, as a device that pushed it
        /// would have left it.
        fn holding(blob: &[u8], generation: u64) -> Self {
            Self {
                blob: Some(blob.to_vec()),
                manifest: Some(serde_json::to_string(&manifest_for(blob, generation)).unwrap()),
            }
        }
    }

    fn drive(remote: Remote) -> impl Fn(&Seen) -> Vec<u8> + Send + Sync + 'static {
        move |request| {
            let blob = remote
                .blob
                .as_ref()
                .map(|bytes| (BLOB_ID, SYNC_BLOB_NAME, bytes.len()));
            let manifest = remote
                .manifest
                .as_ref()
                .map(|json| (MANIFEST_ID, SYNC_MANIFEST_NAME, json.len()));

            if request.method == "GET" && request.path() == "/drive/v3/files" {
                // A listing without `spaces` is a listing of the user's real
                // Drive. Answered as a refusal rather than asserted, so the
                // failure reaches the test as a provider error it can read
                // instead of a panic in a spawned socket task.
                if request.param("spaces").as_deref() != Some(APP_DATA_FOLDER) {
                    return refusal(400, "Bad Request");
                }
                let listed: Vec<(&str, &str, usize)> = match request.param("q").as_deref() {
                    Some("name='better-cloudflare-vault.enc'") => blob.into_iter().collect(),
                    Some("name='better-cloudflare-vault.json'") => manifest.into_iter().collect(),
                    // No `q` at all is the probe, listing the folder itself.
                    None => blob.into_iter().chain(manifest).collect(),
                    Some(_) => Vec::new(),
                };
                return ok_json(&file_list(&listed));
            }

            if request.method == "GET" {
                if let Some(id) = request.path().strip_prefix("/drive/v3/files/") {
                    if id == BLOB_ID {
                        if let Some(bytes) = remote.blob.as_ref() {
                            return ok_bytes(bytes);
                        }
                    }
                    if id == MANIFEST_ID {
                        if let Some(json) = remote.manifest.as_ref() {
                            return ok_bytes(json.as_bytes());
                        }
                    }
                    return refusal(404, "Not Found");
                }
            }

            if request.is_upload() && (request.method == "POST" || request.method == "PATCH") {
                return ok_json("{\"id\":\"written\"}");
            }

            refusal(500, "Internal Server Error")
        }
    }

    // ── probe ────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn an_expired_token_is_unauthorised() {
        let stub = serve(|_| refusal(401, "Unauthorized")).await;

        let error = stub.engine("ya29.expired").probe().await.unwrap_err();

        assert!(matches!(error, SyncError::Unauthorised), "{error:?}");
        assert_eq!(error.code(), "unauthorised");
        let seen = stub.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0].header("authorization").as_deref(),
            Some("Bearer ya29.expired")
        );
        assert_eq!(seen[0].param("spaces").as_deref(), Some(APP_DATA_FOLDER));
    }

    #[tokio::test]
    async fn a_forbidden_token_is_also_unauthorised() {
        let stub = serve(|_| refusal(403, "Forbidden")).await;
        let error = stub.engine("ya29.wrong-scope").probe().await.unwrap_err();
        assert!(matches!(error, SyncError::Unauthorised), "{error:?}");
    }

    #[tokio::test]
    async fn an_empty_app_data_folder_probes_clean() {
        let stub = serve(drive(Remote::empty())).await;

        assert!(
            stub.engine("ya29.fresh").probe().await.is_ok(),
            "a configured account that has never pushed must probe clean"
        );
    }

    #[tokio::test]
    async fn a_probe_never_reports_a_404_as_nothing_pushed() {
        // `from_status` maps 404 to NoRemoteBlob, which is right for an object
        // and wrong for a listing: the probe asked nothing about a blob.
        let stub = serve(|_| refusal(404, "Not Found")).await;

        let error = stub.engine("ya29.token").probe().await.unwrap_err();

        assert_eq!(error.code(), "provider-error", "{error:?}");
    }

    // ── reads ────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_missing_manifest_is_absence_and_not_a_failure() {
        let stub = serve(drive(Remote::empty())).await;

        let manifest = stub.engine("ya29.token").fetch_manifest().await.unwrap();

        assert!(manifest.is_none());
    }

    #[tokio::test]
    async fn a_manifest_is_found_by_name_then_read_by_id() {
        let stub = serve(drive(Remote::holding(b"sealed-envelope", 4))).await;

        let manifest = stub
            .engine("ya29.token")
            .fetch_manifest()
            .await
            .unwrap()
            .unwrap();

        assert_eq!(manifest.generation, 4);
        assert_eq!(manifest.checksum, checksum_hex(b"sealed-envelope"));
        let seen = stub.seen();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(
            seen[0].param("q").as_deref(),
            Some("name='better-cloudflare-vault.json'")
        );
        assert_eq!(seen[1].path(), "/drive/v3/files/manifest-id");
        assert_eq!(seen[1].param("alt").as_deref(), Some("media"));
    }

    #[tokio::test]
    async fn an_absent_blob_is_no_remote_blob() {
        let stub = serve(drive(Remote::empty())).await;

        let error = stub.engine("ya29.token").fetch_blob().await.unwrap_err();

        assert!(matches!(error, SyncError::NoRemoteBlob), "{error:?}");
    }

    #[tokio::test]
    async fn a_blob_round_trips() {
        let stub = serve(drive(Remote::holding(b"sealed-envelope", 1))).await;

        let blob = stub.engine("ya29.token").fetch_blob().await.unwrap();

        assert_eq!(blob, b"sealed-envelope");
    }

    // ── bounds ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_listing_that_declares_an_oversized_file_is_refused_before_the_download() {
        let stub = serve(|request: &Seen| {
            if request.path() == "/drive/v3/files" {
                ok_json(&file_list(&[(
                    BLOB_ID,
                    SYNC_BLOB_NAME,
                    MAX_SYNC_ENVELOPE_BYTES + 1,
                )]))
            } else {
                ok_bytes(&vec![b'x'; MAX_SYNC_ENVELOPE_BYTES + 1])
            }
        })
        .await;

        let error = stub.engine("ya29.token").fetch_blob().await.unwrap_err();

        assert!(matches!(error, SyncError::TooLarge), "{error:?}");
        assert_eq!(
            stub.seen().len(),
            1,
            "a size Drive already reported was downloaded anyway"
        );
    }

    /// The declared length is refused *on the declaration*, before the bytes
    /// are transferred — which is only observable if the body is smaller than
    /// what the header claims. Serving the full oversized body instead would
    /// let the streaming bound pass this test on its own, and then the header
    /// check could be deleted without a single test noticing.
    #[tokio::test]
    async fn a_declared_oversized_length_is_refused_before_the_transfer() {
        let stub = serve(|request: &Seen| {
            if request.path() == "/drive/v3/files" {
                // No `size`: Drive omits it for some files, so the listing
                // cannot be the only bound.
                ok_json("{\"files\":[{\"id\":\"blob-id\",\"name\":\"better-cloudflare-vault.enc\"}]}")
            } else {
                let mut bytes = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
                    MAX_SYNC_ENVELOPE_BYTES + 1
                )
                .into_bytes();
                bytes.extend_from_slice(b"a short body behind a long claim");
                bytes
            }
        })
        .await;

        let error = stub.engine("ya29.token").fetch_blob().await.unwrap_err();

        assert!(
            matches!(error, SyncError::TooLarge),
            "a declared length over the bound was transferred anyway: {error:?}"
        );
    }

    #[tokio::test]
    async fn a_chunked_body_with_no_declared_length_is_bounded_while_it_streams() {
        let stub = serve(|request: &Seen| {
            if request.path() == "/drive/v3/files" {
                ok_json(
                    "{\"files\":[{\"id\":\"blob-id\",\"name\":\"better-cloudflare-vault.enc\"}]}",
                )
            } else {
                chunked(&vec![b'x'; MAX_SYNC_ENVELOPE_BYTES * 2])
            }
        })
        .await;

        let error = stub.engine("ya29.token").fetch_blob().await.unwrap_err();

        assert!(
            matches!(error, SyncError::TooLarge),
            "a response with no length was read to the end: {error:?}"
        );
    }

    // ── the guard ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_remote_whose_generation_moved_refuses_the_put_and_uploads_nothing() {
        let blob = b"sealed-envelope";
        let stub = serve(drive(Remote::holding(b"another-device", 7))).await;

        let outcome = stub
            .engine("ya29.token")
            .put(blob, &manifest_for(blob, 6), GenerationGuard(Some(5)))
            .await
            .unwrap();

        match outcome {
            PutOutcome::Refused(refused) => assert_eq!(
                refused.remote.generation, 7,
                "the caller is told what the remote actually holds"
            ),
            PutOutcome::Written => panic!("a remote that moved was overwritten"),
        }
        // The return value is half the assertion. A guard that refuses after
        // uploading has still lost the other device's keys.
        assert!(
            stub.uploads().is_empty(),
            "the guard refused and uploaded anyway: {:?}",
            stub.uploads()
        );
        assert!(
            stub.seen().iter().all(|request| request.method == "GET"),
            "a refused put wrote something: {:?}",
            stub.seen()
        );
    }

    #[tokio::test]
    async fn a_first_push_onto_a_non_empty_remote_is_refused() {
        let blob = b"sealed-envelope";
        let stub = serve(drive(Remote::holding(b"another-device", 1))).await;

        let outcome = stub
            .engine("ya29.token")
            .put(blob, &manifest_for(blob, 1), GenerationGuard(None))
            .await
            .unwrap();

        match outcome {
            PutOutcome::Refused(refused) => assert_eq!(refused.remote.generation, 1),
            PutOutcome::Written => {
                panic!("a fresh install claimed a remote that already held a vault")
            }
        }
        assert!(stub.uploads().is_empty(), "{:?}", stub.uploads());
    }

    #[tokio::test]
    async fn a_first_push_creates_both_objects_in_the_app_data_folder() {
        let blob = b"sealed-envelope";
        let stub = serve(drive(Remote::empty())).await;

        let outcome = stub
            .engine("ya29.token")
            .put(blob, &manifest_for(blob, 1), GenerationGuard(None))
            .await
            .unwrap();

        assert!(matches!(outcome, PutOutcome::Written), "{outcome:?}");
        let uploads = stub.uploads();
        assert_eq!(uploads.len(), 2, "{uploads:?}");
        assert!(
            uploads.iter().all(|upload| upload.method == "POST"),
            "a create cannot PATCH an id it does not have: {uploads:?}"
        );

        let blob_upload = &uploads[0];
        assert_eq!(blob_upload.path(), "/upload/drive/v3/files");
        assert_eq!(
            blob_upload.param("uploadType").as_deref(),
            Some("multipart")
        );
        let body = blob_upload.body_text();
        assert!(
            body.contains("\"name\":\"better-cloudflare-vault.enc\""),
            "{body}"
        );
        assert!(
            body.contains("\"parents\":[\"appDataFolder\"]"),
            "a vault in My Drive is a vault someone shares by accident: {body}"
        );
        assert!(body.contains("sealed-envelope"), "{body}");

        // The boundary in the header is the one framing the body.
        let content_type = blob_upload.header("content-type").unwrap();
        let boundary = content_type
            .strip_prefix("multipart/related; boundary=")
            .expect(&content_type);
        assert_eq!(body.matches(&format!("--{boundary}")).count(), 3, "{body}");

        let manifest_upload = uploads[1].body_text();
        assert!(
            manifest_upload.contains("\"name\":\"better-cloudflare-vault.json\""),
            "{manifest_upload}"
        );
        assert!(
            manifest_upload.contains("\"generation\":1"),
            "{manifest_upload}"
        );
    }

    #[tokio::test]
    async fn a_matching_generation_replaces_both_objects_in_place() {
        let blob = b"new-envelope";
        let stub = serve(drive(Remote::holding(b"old-envelope", 2))).await;

        let outcome = stub
            .engine("ya29.token")
            .put(blob, &manifest_for(blob, 3), GenerationGuard(Some(2)))
            .await
            .unwrap();

        assert!(matches!(outcome, PutOutcome::Written), "{outcome:?}");
        let uploads = stub.uploads();
        assert_eq!(uploads.len(), 2, "{uploads:?}");
        assert_eq!(uploads[0].method, "PATCH");
        assert_eq!(uploads[0].path(), "/upload/drive/v3/files/blob-id");
        assert_eq!(uploads[1].method, "PATCH");
        assert_eq!(uploads[1].path(), "/upload/drive/v3/files/manifest-id");
        assert!(
            !uploads[0].body_text().contains("parents"),
            "Drive refuses a parent change on an update: {}",
            uploads[0].body_text()
        );

        // The window: the request immediately before the first upload is the
        // manifest re-read, not a lookup that could have been done earlier.
        let seen = stub.seen();
        let first_upload = seen.iter().position(Seen::is_upload).unwrap();
        let guard_read = &seen[first_upload - 1];
        assert_eq!(
            guard_read.path(),
            "/drive/v3/files/manifest-id",
            "something was put between the guard read and the upload: {seen:?}"
        );
        assert_eq!(guard_read.param("alt").as_deref(), Some("media"));
    }

    #[tokio::test]
    async fn a_remote_that_vanished_is_created_rather_than_wedged() {
        // Pins the decision documented in `put`: `GuardRefused` has nowhere to
        // put "there is nothing there any more", and refusing forever is
        // worse than re-creating something nothing can be lost to.
        let blob = b"sealed-envelope";
        let stub = serve(drive(Remote::empty())).await;

        let outcome = stub
            .engine("ya29.token")
            .put(blob, &manifest_for(blob, 9), GenerationGuard(Some(8)))
            .await
            .unwrap();

        assert!(matches!(outcome, PutOutcome::Written), "{outcome:?}");
        assert_eq!(stub.uploads().len(), 2);
    }

    #[tokio::test]
    async fn an_upload_that_fails_is_reported_and_not_swallowed() {
        let stub = serve(|request: &Seen| {
            if request.is_upload() {
                refusal(500, "Internal Server Error")
            } else {
                ok_json("{\"files\":[]}")
            }
        })
        .await;

        let blob = b"sealed-envelope";
        let error = stub
            .engine("ya29.token")
            .put(blob, &manifest_for(blob, 1), GenerationGuard(None))
            .await
            .unwrap_err();

        assert_eq!(error.code(), "provider-error", "{error:?}");
        assert_eq!(
            stub.uploads().len(),
            1,
            "the manifest was uploaded although the blob never landed"
        );
    }

    // ── archive ──────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn an_archive_is_one_additive_upload_named_after_its_suffix() {
        let stub = serve(drive(Remote::holding(b"live-envelope", 3))).await;

        stub.engine("ya29.token")
            .archive(
                "2026-02-03T04-05-06Z",
                b"discarded-envelope",
                &manifest_for(b"discarded-envelope", 4),
            )
            .await
            .unwrap();

        let seen = stub.seen();
        assert_eq!(
            seen.len(),
            2,
            "an archive looks nothing up, and writes the blob then its manifest"
        );
        assert!(seen.iter().all(|r| r.method == "POST"));

        let blob = seen[0].body_text();
        assert!(
            blob.contains("\"name\":\"better-cloudflare-vault.2026-02-03T04-05-06Z.enc\""),
            "{blob}"
        );
        assert!(blob.contains("discarded-envelope"), "{blob}");
        assert!(blob.contains("\"parents\":[\"appDataFolder\"]"), "{blob}");

        // `.json`, because this one is readable JSON and not an envelope.
        let recorded = seen[1].body_text();
        assert!(
            recorded.contains("\"name\":\"better-cloudflare-vault.2026-02-03T04-05-06Z.json\""),
            "{recorded}"
        );
        assert!(
            recorded.contains("\"parents\":[\"appDataFolder\"]"),
            "{recorded}"
        );
    }

    /// A sealed envelope does not record its own iteration count, so an
    /// archive without the manifest's parameters is bytes nobody can decrypt.
    #[tokio::test]
    async fn an_archived_blob_keeps_the_parameters_needed_to_open_it() {
        let stub = serve(drive(Remote::empty())).await;
        let expected = manifest_for(b"discarded-envelope", 4);

        stub.engine("ya29.token")
            .archive("2026-02-03T04-05-06Z", b"discarded-envelope", &expected)
            .await
            .unwrap();

        let seen = stub.seen();
        let recorded = seen[1].body_text();
        for needle in [
            &format!("\"iterations\":{}", expected.iterations),
            &format!("\"keyLength\":{}", expected.key_length),
            &format!("\"algorithm\":\"{}\"", expected.algorithm),
            &format!("\"generation\":{}", expected.generation),
        ] {
            assert!(
                recorded.contains(needle.as_str()),
                "the archived manifest is missing {needle}: {recorded}"
            );
        }
    }

    /// The WebDAV engine has to refuse a suffix that walks out of its
    /// collection, because there a name is a path. Here it is not: a Drive
    /// file name is an opaque label on an object whose location is its
    /// `parents`, so the worst a hostile suffix achieves is an oddly named
    /// object in the app data folder. Pinned rather than assumed, because the
    /// two engines taking the same argument to different places is exactly
    /// the kind of asymmetry that gets "fixed" in the wrong direction.
    #[tokio::test]
    async fn an_archive_suffix_is_a_name_and_not_a_path() {
        let stub = serve(drive(Remote::empty())).await;

        stub.engine("ya29.token")
            .archive(
                "../../../etc/passwd",
                b"discarded-envelope",
                &manifest_for(b"discarded-envelope", 4),
            )
            .await
            .unwrap();

        let seen = stub.seen();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].path(), "/upload/drive/v3/files");
        let body = seen[0].body_text();
        assert!(
            body.contains("\"parents\":[\"appDataFolder\"]"),
            "the suffix moved the object out of the app data folder: {body}"
        );
    }
}
