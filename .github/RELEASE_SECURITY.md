# Release security contract

Automated desktop releases retain the `YY.N` tag format and exactly twelve
downloadable assets: one binary plus one SHA-256 file for Linux, macOS, and
Windows on x64 and arm64.

Before publication, the workflow:

- globally serializes the publication stage;
- requires the release commit to still be the remote `main` tip before tag
  allocation and immediately before publication;
- validates each platform artifact in an isolated directory;
- inspects the built application executable as ELF, Mach-O, or PE and rejects
  the wrong architecture;
- verifies every checksum, downloads the draft again, and compares every byte
  with the build output;
- creates GitHub/Sigstore build-provenance attestations without adding files to
  the twelve-asset release contract;
- pins release builds to Node 24.18.1 and Rust 1.97.1;
- refuses to overwrite release assets and safely removes a failed draft and
  newly reserved tag only when both still target the expected commit.

Consumers should verify both controls:

```sh
sha256sum --check better-cloudflare-PLATFORM-ARCH.EXT.sha256
gh attestation verify better-cloudflare-PLATFORM-ARCH.EXT \
  --repo supermarsx/better-cloudflare
```

## Explicit residual controls

The generated executables are not Authenticode-signed, Apple Developer
ID-signed/notarized, or Linux package-signed. Build provenance authenticates the
repository workflow and commit, but it is not a substitute for platform code
signing. Those controls require separately protected signing identities and
secrets.

Repository administrators must still protect `main`, require the CI and
security checks, restrict bypasses, protect the `production-release`
environment, enable Dependabot alerts, and configure GitHub Pages to deploy
from Actions. These are external repository settings and are intentionally not
changed by workflow code.

The former `PAGES_ADMIN_TOKEN` bootstrap path is no longer used. Remove that
repository secret if it still exists.
