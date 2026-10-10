//! The local-folder engine.
//!
//! # Why a folder instead of talking to a cloud API
//!
//! This replaced a Google Drive engine, and the replacement is strictly
//! better. That engine needed an access token the user obtained themselves and
//! pasted in, because a desktop OAuth client cannot keep a client secret and
//! this repository is public — so it expired, and re-pasting it was the price
//! of the feature working at all.
//!
//! A folder has no credential to expire, and it works with every sync client
//! the user already runs: Google Drive for desktop, Dropbox, OneDrive, iCloud
//! Drive, Syncthing, an SMB or NFS mount, or a USB stick. The app writes two
//! files; something the user already trusts carries them. That is a smaller
//! thing for this app to be responsible for, and it covers more providers than
//! an API client ever would.
//!
//! It is also the strongest of the three guards. A rename within one
//! filesystem is atomic, so a reader never sees half a vault — where WebDAV
//! needs a staged `PUT` plus a `MOVE`, and the Drive engine could only do a
//! read-then-write across a network round trip.
//!
//! # A folder that has vanished is not an empty folder
//!
//! This is the one decision here that runs opposite to [`crate::webdav`], and
//! it matters more than it looks. A missing WebDAV collection means "nothing
//! has been pushed yet", and that engine creates it on the first push. A
//! missing *local folder* almost always means an unmounted network share, an
//! unplugged disk, or a cloud client that has not started — and
//! `fs::create_dir_all` would cheerfully succeed, writing the vault into a
//! directory on the local disk that shadows the mount point.
//!
//! The user would see a successful push. The sync client would never see the
//! bytes. The next device would restore a vault that was never updated, and
//! the mount coming back would hide the local directory again, taking the only
//! copy of those writes with it.
//!
//! So **this engine never creates the configured folder.** A folder that is
//! absent, or is not a directory, is [`SyncError::Unreachable`] — the same
//! answer as a network that is down, which is what it usually is. The folder
//! is chosen through a native picker, so it exists when it is configured; if
//! it stops existing, something outside this app changed.
//!
//! # The sync client is a second writer
//!
//! Unlike the WebDAV case, something else is modifying this directory by
//! design. Two consequences, both handled rather than hoped about:
//!
//! - **The blob can change underneath a running app.** That is what the
//!   generation guard is for, and it is why [`SyncEngine::put`] re-reads the
//!   manifest immediately before it commits.
//! - **Sync clients write conflict copies** — `vault (1).enc`,
//!   `vault.sync-conflict-20260101.enc`, `vault-DESKTOP-ABC.enc`. This engine
//!   reads and writes two exact names and never globs, so a conflict copy is
//!   left alone for the user to look at rather than silently adopted. It also
//!   means a conflict copy is *invisible* here, which is the honest trade: this
//!   app cannot tell the user their provider made one.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

use crate::{
    GenerationGuard, GuardRefused, PutOutcome, SyncEngine, SyncError, SyncManifest,
    MAX_SYNC_ENVELOPE_BYTES, SYNC_BLOB_NAME, SYNC_MANIFEST_NAME,
};

/// The largest manifest this will read.
///
/// A manifest is a few hundred bytes, so this is headroom. It exists because
/// the file comes from a directory this process does not control — a sync
/// client, another device, or a user with a text editor — and a bound applied
/// after the read is not a bound.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

/// Where bytes are staged before they become the live blob. See
/// [`SyncEngine::put`]: the rename off this name is the atomic step.
const INCOMING_SUFFIX: &str = ".incoming";

/// What [`SyncEngine::probe`] writes to prove the folder is writable.
///
/// **Deliberately not [`INCOMING_SUFFIX`].** The probe used to write
/// `<manifest>.incoming`, which is byte-for-byte the path
/// [`FolderEngine::write_atomic`] stages the manifest at — and nothing
/// serialises a probe against a push (`commands::sync` declines a lock on
/// purpose, reasoning that two pushes are made safe by the generation guard;
/// that guard is about two devices diverging and says nothing about two local
/// operations sharing a temp filename).
///
/// So a "Test" landing inside a push could truncate the staged manifest, or
/// delete it between the write and the rename — and in the worst interleaving
/// the probe's *empty* file is what the push renames into place, leaving a
/// zero-byte manifest that reports `Corrupt` on the next pull. Narrow, needing
/// a Test during a push, and recoverable by pushing again; also free to make
/// impossible, which is what a separate suffix does.
///
/// Reported by the ko-KR translator while checking the strings against this
/// file, as a coupling worth removing rather than as an observed failure.
const PROBE_SUFFIX: &str = ".probe";

/// A configured local folder.
pub struct FolderEngine {
    root: PathBuf,
}

impl FolderEngine {
    /// Validate the path's *shape*. Existence is checked per operation.
    ///
    /// Only the shape is checked here, because a folder that exists at
    /// configure time and not at push time is the ordinary case for a mount —
    /// so "does it exist" is never a question this constructor can answer
    /// usefully. What it can refuse is a path that could never be right.
    pub fn new(root: &str) -> Result<Self, SyncError> {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            return Err(SyncError::NotConfigured);
        }
        let path = Path::new(trimmed);
        // Relative paths are refused rather than resolved. A relative path
        // would be read against the process's working directory, which for a
        // bundled desktop app is wherever the launcher happened to start it —
        // so the same setting would mean a different folder depending on how
        // the app was opened, and the vault would land somewhere the user
        // never chose.
        if !path.is_absolute() {
            return Err(SyncError::NotConfigured);
        }
        // `..` is refused for the same reason it is refused in an archive
        // suffix: a stored setting is not a thing to resolve, and a path the
        // user cannot read back literally is a path they cannot verify.
        if path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(SyncError::NotConfigured);
        }
        Ok(Self {
            root: path.to_path_buf(),
        })
    }

    /// The configured folder, confirmed to be a directory right now.
    ///
    /// Every operation goes through this, so a vanished mount is caught once,
    /// in one place, with the reason the user needs — and never by creating
    /// what is missing. See the module header.
    fn root_now(&self) -> Result<&Path, SyncError> {
        match fs::metadata(&self.root) {
            Ok(meta) if meta.is_dir() => Ok(&self.root),
            Ok(_) => Err(SyncError::Unreachable(format!(
                "{} is not a folder",
                self.root.display()
            ))),
            Err(error) if error.kind() == ErrorKind::NotFound => Err(SyncError::Unreachable(
                format!("{} is not there", self.root.display()),
            )),
            Err(error) => Err(SyncError::Unreachable(error.to_string())),
        }
    }

    fn object(&self, name: &str) -> Result<PathBuf, SyncError> {
        Ok(self.root_now()?.join(name))
    }

    /// Where [`SyncEngine::probe`] writes, named in one place.
    ///
    /// Two callers need this path — the probe that creates it and the push
    /// that collects it — and two `format!`s over the same two constants are
    /// two places for the name to drift apart. That drift would not fail a
    /// test: the probe would still clean up after itself in the ordinary case,
    /// and the collector would quietly start removing a file nothing creates.
    fn probe_path(root: &Path) -> PathBuf {
        root.join(format!("{SYNC_MANIFEST_NAME}{PROBE_SUFFIX}"))
    }

    /// Write `bytes` to `path`, reporting success only once the filesystem
    /// has accepted them.
    ///
    /// # Why not `fs::write`
    ///
    /// `fs::write` is `File::create(path)?.write_all(bytes)` followed by a
    /// drop, and `File`'s `Drop` closes the handle and **discards the close
    /// result**. Rust has no stable `File::close()` to observe it with, so
    /// `sync_all` is the only portable way to make a deferred failure surface
    /// while there is still a `Result` to carry it.
    ///
    /// That matters here because this engine's folder is frequently not a
    /// local disk. SMB and NFS buffer writes on the client and report a full
    /// volume, an exceeded quota, an I/O error, a dropped session and a share
    /// remounted read-only **at close** rather than at the write. Through
    /// `fs::write` every one of those returns `Ok`, and then
    /// [`SyncEngine::put`] renames a staged file whose bytes never left this
    /// machine — the rename is a metadata operation and can succeed anyway —
    /// and reports a new generation. The user is told a push worked that did
    /// not.
    ///
    /// [`SyncEngine::probe`] is the sharper case, and the reason this is not
    /// left as a documented gap. Its entire job is answering "can this app
    /// write here", and an empty file is the write *most* likely to be
    /// satisfied out of the client-side cache and never reach the wire at
    /// all — so the one operation whose purpose is to be certain was the one
    /// most likely to be wrong, on exactly the filesystems a shared sync
    /// folder tends to live on.
    ///
    /// # The fsync is affordable, and this is not a hot path
    ///
    /// Two per push and two per archive, on a payload bounded at 96 KiB by
    /// [`MAX_SYNC_ENVELOPE_BYTES`], with auto-push on a minutes-scale timer.
    /// Written down because an `fsync` sitting in what looks like a write
    /// path is the kind of thing a later reader removes on principle.
    ///
    /// # What this does and does not prove
    ///
    /// It makes a close-time error *reportable*. It is not a durability
    /// guarantee for the directory entry: see the report accompanying this
    /// change for the `fs::rename` question, which is deliberately left
    /// alone. And the close-time capture itself is not covered by a test —
    /// this crate's tests run against a local temp directory where `close`
    /// does not fail. What is covered is that every write in this engine
    /// routes through here; see
    /// `tests::every_write_in_this_engine_goes_through_the_durable_path`.
    ///
    /// Returns `io::Result` rather than [`SyncError`] so each call site keeps
    /// the mapping it needs — the probe's in particular must stay the OS
    /// error alone.
    fn write_durably(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let mut file = fs::File::create(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    }

    /// Read a file, bounded, treating absence as `Ok(None)`.
    ///
    /// The size is taken from the metadata and refused *before* the read, so
    /// an oversized file costs one `stat` rather than its own length in
    /// memory. A file that grows between the two is still bounded, because
    /// the read itself is capped.
    fn read_bounded(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, SyncError> {
        let meta = match fs::metadata(path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(SyncError::Provider(error.to_string())),
        };
        if !meta.is_file() {
            return Err(SyncError::Provider(format!(
                "{} is not a file",
                path.display()
            )));
        }
        if meta.len() > limit {
            return Err(SyncError::TooLarge);
        }
        let bytes = fs::read(path).map_err(|error| match error.kind() {
            ErrorKind::NotFound => SyncError::NoRemoteBlob,
            _ => SyncError::Provider(error.to_string()),
        })?;
        if bytes.len() as u64 > limit {
            return Err(SyncError::TooLarge);
        }
        Ok(Some(bytes))
    }

    /// Write `bytes` to `name` atomically: stage beside it, then rename.
    ///
    /// The staging file is in the same directory on purpose — a rename is only
    /// atomic within one filesystem, and a temp directory is frequently on
    /// another. `fs::rename` replaces an existing destination on every
    /// platform this ships to (on Windows it is `MoveFileExW` with
    /// `MOVEFILE_REPLACE_EXISTING`), so a reader sees either the old file or
    /// the new one and never a partial write.
    fn write_atomic(&self, name: &str, bytes: &[u8]) -> Result<(), SyncError> {
        let root = self.root_now()?;
        let staged = root.join(format!("{name}{INCOMING_SUFFIX}"));
        Self::write_durably(&staged, bytes)
            .map_err(|error| SyncError::Provider(error.to_string()))?;
        match fs::rename(&staged, root.join(name)) {
            Ok(()) => Ok(()),
            Err(error) => {
                // Leaving a staged file behind would be read as a half-written
                // push by the next person to look in the folder, so it goes
                // even on the failure path. The rename's error is what is
                // reported; the cleanup's is not, because the caller needs to
                // hear why the write failed.
                let _ = fs::remove_file(&staged);
                Err(SyncError::Provider(error.to_string()))
            }
        }
    }

    /// Names an archive, refusing a suffix that could leave the folder.
    ///
    /// The suffix comes from the command layer, which builds it from a
    /// timestamp — so this is defence in depth rather than a live threat. It
    /// is here because a path join is the one place where a value that was
    /// never meant to be a path becomes one.
    fn archive_names(suffix: &str) -> Result<(String, String), SyncError> {
        if suffix.is_empty()
            || suffix.contains('/')
            || suffix.contains('\\')
            || suffix.contains("..")
            || suffix.contains('\0')
        {
            return Err(SyncError::Provider(
                "an archive suffix is a name, not a path".into(),
            ));
        }
        let stem = SYNC_BLOB_NAME
            .strip_suffix(".enc")
            .unwrap_or(SYNC_BLOB_NAME);
        Ok((
            format!("{stem}.{suffix}.enc"),
            // `.json`, not `.enc`: this is the plaintext record of the
            // parameters the envelope was sealed with, and a `.enc` extension
            // on readable JSON invites someone to try to decrypt it.
            format!("{stem}.{suffix}.json"),
        ))
    }
}

#[async_trait::async_trait]
impl SyncEngine for FolderEngine {
    /// Confirm the folder is there, is a directory, and can be written to.
    ///
    /// Writability is proved rather than assumed, by staging and removing a
    /// probe file. A read-only mount — a disconnected share remounted
    /// read-only, a CD, a permissions change — reads identically to a working
    /// one until the first push, and "Test" is the moment the user is asking
    /// to be told. An empty folder is a successful probe, as the trait
    /// requires: nothing has been pushed yet.
    ///
    /// # The removal is best-effort, and something else collects
    ///
    /// Writability is the only question this answers, and the write answers
    /// it. A folder that accepted the file and then refused the unlink is
    /// still a writable folder — on Windows that is a sharing violation from
    /// an antivirus scanner or from the user's own sync client, both of which
    /// open a new file the moment it appears — so reporting a failure there
    /// would send the user looking for a problem they do not have.
    ///
    /// What the dropped error costs is a stray zero-byte file, in a folder
    /// whose whole purpose is that something else mirrors it to every other
    /// device. So it is collected rather than merely hoped about: see the
    /// unlink at the top of [`SyncEngine::put`], which is what lets this one
    /// be best-effort.
    async fn probe(&self) -> Result<(), SyncError> {
        let root = self.root_now()?;
        let probe = Self::probe_path(root);
        let wrote = Self::write_durably(&probe, b"")
            // The message is the OS error alone, with no prose of ours in
            // front of it. The renderer frames this path as a quotation —
            // "The filesystem said: …" — so a prefix this app composed would
            // make that frame false, and a user would read
            // "The filesystem said: cannot write here: Access is denied."
            // where only the second half was ever the filesystem's. Reported
            // by the ru-RU translator, who found the frame quoting our words.
            // The surrounding failure text supplies the context the prefix
            // used to.
            .map_err(|error| SyncError::Provider(error.to_string()));
        // Attempted whichever way the write went, and before the error is
        // propagated: `fs::write` creates the file before it can fail writing
        // into it, so the failure path leaves one behind too.
        let _ = fs::remove_file(&probe);
        wrote
    }

    async fn fetch_manifest(&self) -> Result<Option<SyncManifest>, SyncError> {
        let path = self.object(SYNC_MANIFEST_NAME)?;
        let Some(bytes) = Self::read_bounded(&path, MAX_MANIFEST_BYTES)? else {
            return Ok(None);
        };
        let text = String::from_utf8(bytes).map_err(|_| SyncError::Corrupt)?;
        SyncManifest::parse(&text).map(Some)
    }

    async fn fetch_blob(&self) -> Result<Vec<u8>, SyncError> {
        let path = self.object(SYNC_BLOB_NAME)?;
        Self::read_bounded(&path, MAX_SYNC_ENVELOPE_BYTES as u64)?.ok_or(SyncError::NoRemoteBlob)
    }

    /// Stage, check the guard, commit the manifest, then commit the blob.
    ///
    /// The order mirrors [`crate::webdav`] so that a reader comparing the two
    /// engines sees one sequence: the live blob is not touched until the guard
    /// has passed, so a refusal costs a staged file and never a lost vault.
    ///
    /// The guard is a read-then-write, as it must be — a filesystem offers no
    /// precondition on a write. The window is a few microseconds rather than a
    /// network round trip, and the second writer here is a sync client
    /// replacing the file, which the next push's guard then catches.
    async fn put(
        &self,
        blob: &[u8],
        manifest: &SyncManifest,
        guard: GenerationGuard,
    ) -> Result<PutOutcome, SyncError> {
        let root = self.root_now()?.to_path_buf();
        // Collect a probe file an earlier [`SyncEngine::probe`] could not
        // remove. That unlink is best-effort by design, so nothing inside
        // `probe` can promise the file goes; a push is the operation that runs
        // on a timer, which makes it the one that reliably comes back to the
        // folder.
        //
        // Before the guard rather than after it, so a device stuck refusing
        // every push — a conflict nobody has resolved yet — still tidies up.
        // Unconditional rather than guarded by an `exists`, which would cost
        // the same `stat` and then race it; the usual answer is `NotFound` and
        // that is not an error worth having.
        let _ = fs::remove_file(Self::probe_path(&root));
        let staged = root.join(format!("{SYNC_BLOB_NAME}{INCOMING_SUFFIX}"));
        Self::write_durably(&staged, blob)
            .map_err(|error| SyncError::Provider(error.to_string()))?;

        // Re-read as late as possible: everything above this is reversible.
        let remote = self.fetch_manifest().await?;
        let agreed = match (guard.0, remote.as_ref()) {
            (None, None) => true,
            (Some(expected), Some(found)) => expected == found.generation,
            _ => false,
        };
        if !agreed {
            let _ = fs::remove_file(&staged);
            // A guard that named a generation against a remote that is now
            // empty cannot be reported as a conflict — `GuardRefused` carries
            // a manifest — so it surfaces as `Corrupt`, which is the honest
            // reading: the pair in the folder no longer makes sense together.
            let Some(remote) = remote else {
                return Err(SyncError::Corrupt);
            };
            return Ok(PutOutcome::Refused(GuardRefused { remote }));
        }

        let encoded =
            serde_json::to_vec(manifest).map_err(|error| SyncError::Provider(error.to_string()))?;
        self.write_atomic(SYNC_MANIFEST_NAME, &encoded)?;
        match fs::rename(&staged, root.join(SYNC_BLOB_NAME)) {
            Ok(()) => Ok(PutOutcome::Written),
            Err(error) => {
                // The manifest now describes bytes that are not the live blob,
                // which `SyncManifest::describes` reports as `Corrupt` on the
                // next pull rather than handing anyone the wrong vault — and
                // the staged file still holds exactly those bytes, so the
                // repair is a rename. The same window `webdav` documents, and
                // deliberately the one left: the other ordering trades it for
                // a lost write.
                Err(SyncError::Provider(error.to_string()))
            }
        }
    }

    async fn archive(
        &self,
        suffix: &str,
        blob: &[u8],
        manifest: &SyncManifest,
    ) -> Result<(), SyncError> {
        let (blob_name, manifest_name) = Self::archive_names(suffix)?;
        // Blob first, per the trait: a manifest describing bytes that never
        // arrived is worse than bytes whose parameters have to be read off a
        // sibling archive.
        self.write_atomic(&blob_name, blob)?;
        let encoded =
            serde_json::to_vec(manifest).map_err(|error| SyncError::Provider(error.to_string()))?;
        self.write_atomic(&manifest_name, &encoded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{checksum_hex, PAYLOAD_VERSION};

    fn manifest(generation: u64, blob: &[u8]) -> SyncManifest {
        SyncManifest {
            generation,
            checksum: checksum_hex(blob),
            bytes: blob.len() as u64,
            written_at: "2026-10-09T12:00:00Z".into(),
            device_id: "device-1".into(),
            device_label: "Windows 11".into(),
            payload_version: PAYLOAD_VERSION,
            iterations: 600_000,
            key_length: 32,
            algorithm: "PBKDF2-HMAC-SHA256".into(),
        }
    }

    /// A folder that exists, in a temp directory that cleans itself up.
    fn folder() -> (tempfile::TempDir, FolderEngine) {
        let dir = tempfile::tempdir().expect("temp dir");
        let engine = FolderEngine::new(dir.path().to_str().expect("utf-8 path")).expect("engine");
        (dir, engine)
    }

    #[test]
    fn a_relative_path_is_refused() {
        // It would resolve against whatever directory the launcher started the
        // app in, so the same setting would mean different folders.
        assert!(FolderEngine::new("vault").is_err());
        assert!(FolderEngine::new("./vault").is_err());
        assert!(FolderEngine::new("").is_err());
        assert!(FolderEngine::new("   ").is_err());
    }

    #[test]
    fn a_path_with_a_parent_component_is_refused() {
        #[cfg(windows)]
        let hostile = r"C:\Users\someone\..\other\vault";
        #[cfg(not(windows))]
        let hostile = "/home/someone/../other/vault";
        assert!(FolderEngine::new(hostile).is_err());
    }

    #[tokio::test]
    async fn an_empty_folder_probes_clean_and_reports_no_blob() {
        let (_dir, engine) = folder();
        engine
            .probe()
            .await
            .expect("an empty folder is configured, not broken");
        assert!(engine
            .fetch_manifest()
            .await
            .expect("no manifest")
            .is_none());
        assert!(matches!(
            engine.fetch_blob().await,
            Err(SyncError::NoRemoteBlob)
        ));
    }

    /// The decision in the module header, and the one worth a test: a folder
    /// that has gone is an unreachable folder, never one to create.
    #[tokio::test]
    async fn a_folder_that_has_vanished_is_unreachable_and_is_not_recreated() {
        let dir = tempfile::tempdir().expect("temp dir");
        let gone = dir.path().join("unmounted");
        let engine = FolderEngine::new(gone.to_str().expect("utf-8 path")).expect("engine");

        assert!(matches!(
            engine.probe().await,
            Err(SyncError::Unreachable(_))
        ));
        assert!(matches!(
            engine.fetch_manifest().await,
            Err(SyncError::Unreachable(_))
        ));
        assert!(matches!(
            engine
                .put(b"sealed", &manifest(1, b"sealed"), GenerationGuard(None))
                .await,
            Err(SyncError::Unreachable(_))
        ));
        assert!(
            !gone.exists(),
            "recreating a vanished mount writes the vault where the sync client will never look"
        );
    }

    /// A probe must not be able to disturb a push's staged manifest.
    ///
    /// Nothing serialises the two — `commands::sync` declines a lock, and the
    /// generation guard it relies on instead is about two *devices* diverging,
    /// not two local operations sharing a temp filename. The worst
    /// interleaving had the probe's empty file renamed into place as the
    /// manifest, leaving a zero-byte manifest that reads as `Corrupt`. A
    /// separate suffix makes it impossible rather than unlikely.
    #[test]
    fn the_probe_cannot_collide_with_a_staged_write() {
        assert_ne!(
            PROBE_SUFFIX, INCOMING_SUFFIX,
            "a probe sharing the staging suffix can truncate a push mid-write"
        );
        // Named explicitly, because the collision was between two *derived*
        // paths and equal suffixes were the only reason it existed.
        assert_ne!(
            format!("{SYNC_MANIFEST_NAME}{PROBE_SUFFIX}"),
            format!("{SYNC_MANIFEST_NAME}{INCOMING_SUFFIX}"),
        );
        assert_ne!(
            format!("{SYNC_MANIFEST_NAME}{PROBE_SUFFIX}"),
            format!("{SYNC_BLOB_NAME}{INCOMING_SUFFIX}"),
        );
    }

    /// And the behavioural half: a probe leaves a staged manifest alone.
    #[tokio::test]
    async fn a_probe_does_not_touch_a_staged_manifest() {
        let (dir, engine) = folder();
        // Stand in for a push caught between its write and its rename.
        let staged = dir
            .path()
            .join(format!("{SYNC_MANIFEST_NAME}{INCOMING_SUFFIX}"));
        fs::write(&staged, b"a push is mid-flight here").expect("write");

        engine.probe().await.expect("probe");

        assert_eq!(
            fs::read(&staged).expect("the staged manifest must survive a probe"),
            b"a push is mid-flight here",
            "the probe truncated or replaced a push's staged manifest"
        );
        // And the probe cleaned up after itself.
        assert!(
            !dir.path()
                .join(format!("{SYNC_MANIFEST_NAME}{PROBE_SUFFIX}"))
                .exists(),
            "a probe file left behind is read as a half-finished push"
        );
    }

    /// Every write in this engine goes through [`FolderEngine::write_durably`].
    ///
    /// A *structural* assertion, and weaker than a behavioural one — it reads
    /// this file's own source rather than observing a failure. It is written
    /// this way because the behaviour it protects cannot be reached from a
    /// test here: the error `write_durably` exists to surface is one a network
    /// filesystem reports at `close`, and these tests run against a local temp
    /// directory where `close` does not fail.
    ///
    /// What it does catch is the regression that will actually happen —
    /// someone adding a fifth write and reaching for `fs::write` out of
    /// habit, which silently restores a push that reports success for bytes
    /// that never left the machine.
    #[test]
    fn every_write_in_this_engine_goes_through_the_durable_path() {
        let (engine, _tests) = include_str!("folder.rs")
            .split_once("#[cfg(test)]")
            .expect("this file has a test module");
        assert!(
            !engine.contains("fs::write("),
            "a write that bypasses `write_durably` discards the close error, \
             and on SMB or NFS that is a push reporting success for bytes \
             that never arrived"
        );
    }

    /// And the durable path actually flushes before it reports success.
    ///
    /// Separate from the routing test deliberately: one mutation must not be
    /// able to kill both. Routing every write through a helper that no longer
    /// calls `sync_all` is the same defect wearing a better name, and the
    /// test above stays green through it.
    ///
    /// Knowingly the weakest assertion in this file. `sync_all` and its
    /// absence are indistinguishable on a local filesystem, so there is
    /// nothing to observe and the source is all there is to read.
    #[test]
    fn the_durable_path_flushes_before_it_reports_success() {
        let (engine, _tests) = include_str!("folder.rs")
            .split_once("#[cfg(test)]")
            .expect("this file has a test module");
        assert!(
            engine.contains(".sync_all()"),
            "`write_durably` without a flush reports success out of a buffer, \
             which is the defect it was added to remove"
        );
    }

    /// A write that cannot even start is reported rather than swallowed.
    ///
    /// The behavioural bound of the three, and the one that observes the code
    /// instead of reading it: a `write_durably` answering `Ok` on a failed
    /// `File::create` would make every caller's error mapping dead.
    #[test]
    fn a_durable_write_that_cannot_start_is_reported() {
        let dir = tempfile::tempdir().expect("temp dir");
        let nowhere = dir.path().join("no-such-subdirectory").join(SYNC_BLOB_NAME);
        assert!(
            FolderEngine::write_durably(&nowhere, b"sealed").is_err(),
            "a staged write into a directory that is not there must not report success"
        );
    }

    /// A probe file that outlived its probe is collected by the next push.
    ///
    /// `probe` drops the error from its own unlink on purpose — writability
    /// was proved, and a scanner holding the new file open is not a broken
    /// folder — so nothing inside `probe` can promise the file goes. Left
    /// uncollected it is a zero-byte file the user's sync client mirrors to
    /// every device they own, under a name that reads like a half-finished
    /// push.
    #[tokio::test]
    async fn a_push_collects_a_probe_file_an_earlier_probe_could_not_remove() {
        let (dir, engine) = folder();
        let left_behind = dir
            .path()
            .join(format!("{SYNC_MANIFEST_NAME}{PROBE_SUFFIX}"));
        fs::write(&left_behind, b"").expect("write");

        let blob = b"sealed-envelope";
        assert!(matches!(
            engine
                .put(blob, &manifest(1, blob), GenerationGuard(None))
                .await,
            Ok(PutOutcome::Written)
        ));
        assert!(
            !left_behind.exists(),
            "a probe file nothing collects is mirrored to every device the user owns"
        );
    }

    /// And a push that the guard refuses collects it as well.
    ///
    /// Separate from the written case because it pins the unlink's *position*
    /// rather than its existence: a device whose every push is refused — a
    /// conflict nobody has resolved — is exactly the one that would otherwise
    /// keep the stray file forever, so collecting only on the way out would
    /// miss the user it was written for.
    #[tokio::test]
    async fn a_refused_push_collects_a_stale_probe_file_too() {
        let (dir, engine) = folder();
        let theirs = b"the-other-device";
        engine
            .put(theirs, &manifest(4, theirs), GenerationGuard(None))
            .await
            .expect("seed");

        let left_behind = dir
            .path()
            .join(format!("{SYNC_MANIFEST_NAME}{PROBE_SUFFIX}"));
        fs::write(&left_behind, b"").expect("write");

        let mine = b"mine";
        assert!(matches!(
            engine
                .put(mine, &manifest(5, mine), GenerationGuard(Some(3)))
                .await,
            Ok(PutOutcome::Refused(_)),
        ));
        assert!(
            !left_behind.exists(),
            "a device that refuses every push is the one that keeps the stray file"
        );
    }

    #[tokio::test]
    async fn a_path_that_is_a_file_is_not_a_folder() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("not-a-dir");
        fs::write(&file, b"x").expect("write");
        let engine = FolderEngine::new(file.to_str().expect("utf-8 path")).expect("engine");
        assert!(matches!(
            engine.probe().await,
            Err(SyncError::Unreachable(_))
        ));
    }

    #[tokio::test]
    async fn a_first_push_writes_both_objects_and_leaves_no_staged_file() {
        let (dir, engine) = folder();
        let blob = b"sealed-envelope";
        assert!(matches!(
            engine
                .put(blob, &manifest(1, blob), GenerationGuard(None))
                .await,
            Ok(PutOutcome::Written)
        ));

        assert_eq!(fs::read(dir.path().join(SYNC_BLOB_NAME)).unwrap(), blob);
        let found = engine.fetch_manifest().await.unwrap().expect("a manifest");
        assert_eq!(found.generation, 1);
        assert!(found.describes(blob));

        // A staged file left behind reads as a half-finished push to anyone
        // who opens the folder, and to the sync client carrying it.
        let staged: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(INCOMING_SUFFIX))
            .collect();
        assert_eq!(
            staged,
            Vec::<String>::new(),
            "staging files must not survive"
        );
    }

    #[tokio::test]
    async fn a_first_push_onto_a_non_empty_folder_is_refused() {
        let (_dir, engine) = folder();
        let first = b"the-other-device";
        engine
            .put(first, &manifest(4, first), GenerationGuard(None))
            .await
            .expect("seed");

        let mine = b"mine";
        let outcome = engine
            .put(mine, &manifest(1, mine), GenerationGuard(None))
            .await
            .expect("a refusal is not an error");
        match outcome {
            PutOutcome::Refused(refused) => assert_eq!(refused.remote.generation, 4),
            PutOutcome::Written => panic!("a first push must not replace someone else's vault"),
        }
    }

    #[tokio::test]
    async fn a_guard_that_lost_the_race_refuses_and_leaves_the_live_blob_alone() {
        let (dir, engine) = folder();
        let theirs = b"the-vault-that-won";
        engine
            .put(theirs, &manifest(7, theirs), GenerationGuard(None))
            .await
            .expect("seed");

        let mine = b"the-vault-that-lost";
        let outcome = engine
            .put(mine, &manifest(8, mine), GenerationGuard(Some(6)))
            .await
            .expect("a refusal is not an error");
        match outcome {
            PutOutcome::Refused(refused) => assert_eq!(refused.remote.generation, 7),
            PutOutcome::Written => panic!("the guard named 6 against a remote at 7"),
        }

        // The whole point of staging: the winner's bytes are untouched.
        assert_eq!(fs::read(dir.path().join(SYNC_BLOB_NAME)).unwrap(), theirs);
        let still = engine.fetch_manifest().await.unwrap().expect("a manifest");
        assert_eq!(still.generation, 7);
        let staged: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(INCOMING_SUFFIX))
            .collect();
        assert_eq!(staged, Vec::<String>::new());
    }

    #[tokio::test]
    async fn a_matching_guard_replaces_both_objects() {
        let (dir, engine) = folder();
        let first = b"generation-one";
        engine
            .put(first, &manifest(1, first), GenerationGuard(None))
            .await
            .expect("seed");

        let second = b"generation-two-which-is-longer";
        assert!(matches!(
            engine
                .put(second, &manifest(2, second), GenerationGuard(Some(1)))
                .await,
            Ok(PutOutcome::Written)
        ));
        assert_eq!(fs::read(dir.path().join(SYNC_BLOB_NAME)).unwrap(), second);
        assert_eq!(
            engine.fetch_manifest().await.unwrap().unwrap().generation,
            2
        );
    }

    #[tokio::test]
    async fn an_oversized_blob_is_refused_on_its_size_and_never_read() {
        let (dir, engine) = folder();
        fs::write(
            dir.path().join(SYNC_BLOB_NAME),
            vec![b'x'; MAX_SYNC_ENVELOPE_BYTES + 1],
        )
        .expect("write");
        assert!(matches!(
            engine.fetch_blob().await,
            Err(SyncError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn an_unreadable_manifest_is_corrupt_rather_than_absent() {
        let (dir, engine) = folder();
        fs::write(dir.path().join(SYNC_MANIFEST_NAME), b"{ not json").expect("write");
        assert!(matches!(
            engine.fetch_manifest().await,
            Err(SyncError::Corrupt)
        ));
    }

    #[tokio::test]
    async fn an_archive_writes_the_blob_and_the_parameters_that_open_it() {
        let (dir, engine) = folder();
        let discarded = b"the-side-the-user-did-not-keep";
        engine
            .archive(
                "20261009T120000Z-remote",
                discarded,
                &manifest(3, discarded),
            )
            .await
            .expect("archive");

        let blob = dir
            .path()
            .join("better-cloudflare-vault.20261009T120000Z-remote.enc");
        let recorded = dir
            .path()
            .join("better-cloudflare-vault.20261009T120000Z-remote.json");
        assert_eq!(fs::read(&blob).unwrap(), discarded);

        let parsed: SyncManifest =
            serde_json::from_slice(&fs::read(&recorded).unwrap()).expect("readable manifest");
        assert_eq!(parsed.generation, 3);
        assert!(
            parsed.describes(discarded),
            "an archive whose parameters are missing is an archive nobody can open"
        );

        // Additive: the live objects are not involved.
        assert!(!dir.path().join(SYNC_BLOB_NAME).exists());
    }

    #[tokio::test]
    async fn an_archive_suffix_cannot_leave_the_folder() {
        let (dir, engine) = folder();
        for hostile in ["../escaped", "..\\escaped", "sub/dir", "sub\\dir", ""] {
            assert!(
                engine
                    .archive(hostile, b"x", &manifest(1, b"x"))
                    .await
                    .is_err(),
                "{hostile:?} must not be accepted as a name"
            );
        }
        // Nothing landed outside, and nothing landed inside either.
        let written: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(written, Vec::<String>::new());
    }

    /// A conflict copy from the user's sync client must be ignored, not
    /// adopted. This engine addresses two exact names and never globs.
    #[tokio::test]
    async fn a_sync_clients_conflict_copy_is_left_alone() {
        let (dir, engine) = folder();
        let mine = b"mine";
        engine
            .put(mine, &manifest(1, mine), GenerationGuard(None))
            .await
            .expect("seed");
        fs::write(
            dir.path().join("better-cloudflare-vault (1).enc"),
            b"a conflict copy from Dropbox",
        )
        .expect("write");

        assert_eq!(engine.fetch_blob().await.unwrap(), mine);
        assert_eq!(
            engine.fetch_manifest().await.unwrap().unwrap().generation,
            1
        );
    }
}
