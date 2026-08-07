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
- creates GitHub/Sigstore build-provenance attestations and requires the exact
  source commit and reusable signer workflow without adding files to the
  twelve-asset release contract;
- pins release builds to Node 24.18.1 and Rust 1.97.1;
- refuses to overwrite release assets and safely removes a failed draft and
  newly reserved tag only when both still target the expected commit.

Consumers should verify both controls:

```sh
sha256sum --check better-cloudflare-PLATFORM-ARCH.EXT.sha256
gh attestation verify better-cloudflare-PLATFORM-ARCH.EXT \
  --repo supermarsx/better-cloudflare \
  --signer-workflow supermarsx/better-cloudflare/.github/workflows/autopublish.yml \
  --signer-digest EXPECTED_COMMIT_SHA \
  --source-digest EXPECTED_COMMIT_SHA \
  --source-ref refs/heads/main
```

## OSV lockfile gate

The CI and scheduled security workflows scan both `package-lock.json` and
`Cargo.lock` with OSV-Scanner v2.3.8 at the immutable
`sha256:48406c58197201fe55e56615ad9d414f85063da320e204d0b0ed460fb3908dba`
image. Both invocations explicitly load the root `osv-scanner.toml`.

Before scanning, `.github/scripts/validate-osv-policy.py` fails closed unless:

- both root lockfiles, the root config, and both workflow paths exist;
- the config contains exactly the reviewed ID exceptions below, with no
  package-wide overrides;
- every exception remains transitive at the recorded package version, has an
  owner and review reference, and has not expired;
- `openssl`, `serde_with`, Tauri, and its build/runtime packages remain at or
  above their remediated security floors;
- both workflows retain both lockfiles, the config, the pinned scanner image,
  and no `continue-on-error`.

An unfiltered diagnostic scan using an empty config override reports 21
affected Rust packages: 19
maintenance-only notices and two unsoundness advisories. OSV lists nominal
fixed versions for `glib` and `rand`, but neither fix is solver-reachable in
the current Tauri stack: `gtk 0.18` requires `glib ^0.18`, and
`phf_generator 0.8` requires `rand ^0.7`. Replacing either dependency family
requires an upstream Tauri/GTK/HTML-parser migration rather than a safe
lockfile update.

### OSV exception register

Owner for every entry: Better Cloudflare security maintainers. Review and
expiry date for every entry: 2026-10-30.

| ID                  | Package                    | Class        | Rationale and upstream reference                                                                                                                                                                                                                           |
| ------------------- | -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUSTSEC-2024-0413` | `atk@0.18.2`               | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0413.html)                                                                                                          |
| `RUSTSEC-2024-0416` | `atk-sys@0.18.2`           | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0416.html)                                                                                                          |
| `RUSTSEC-2024-0388` | `derivative@2.2.0`         | unmaintained | Maintenance-only notice through `keyring -> secret-service -> zbus`; no compatible keyring-stack removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0388.html)                                                                                |
| `RUSTSEC-2025-0057` | `fxhash@0.2.1`             | unmaintained | Maintenance-only build dependency through `tauri-utils -> kuchikiki -> selectors`; no compatible upstream removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0057.html)                                                                       |
| `RUSTSEC-2024-0412` | `gdk@0.18.2`               | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0412.html)                                                                                                          |
| `RUSTSEC-2024-0418` | `gdk-sys@0.18.2`           | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0418.html)                                                                                                          |
| `RUSTSEC-2024-0411` | `gdkwayland-sys@0.18.2`    | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0411.html)                                                                                                          |
| `RUSTSEC-2024-0417` | `gdkx11@0.18.2`            | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0417.html)                                                                                                          |
| `RUSTSEC-2024-0414` | `gdkx11-sys@0.18.2`        | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0414.html)                                                                                                          |
| `RUSTSEC-2024-0429` | `glib@0.18.5`              | unsound      | No direct application use; fixed `glib 0.20` is incompatible with Tauri's `gtk 0.18` requirement. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)                                                                                        |
| `RUSTSEC-2024-0415` | `gtk@0.18.2`               | unmaintained | Archived GTK3 binding, transitively required by Tauri's Linux runtime; GTK4 is a runtime migration. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0415.html)                                                                                      |
| `RUSTSEC-2024-0420` | `gtk-sys@0.18.2`           | unmaintained | Archived GTK3 binding, transitively required by Tauri's Linux runtime; GTK4 is a runtime migration. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0420.html)                                                                                      |
| `RUSTSEC-2024-0419` | `gtk3-macros@0.18.2`       | unmaintained | Archived GTK3 build dependency, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0419.html)                                                                                                 |
| `RUSTSEC-2024-0384` | `instant@0.1.13`           | unmaintained | Maintenance-only notice through `keyring -> secret-service -> zbus -> futures-lite`; no compatible removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0384.html)                                                                              |
| `RUSTSEC-2024-0370` | `proc-macro-error@1.0.4`   | unmaintained | Maintenance-only GTK3 macro build dependency; no compatible Tauri GTK3 removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)                                                                                                          |
| `RUSTSEC-2026-0097` | `rand@0.7.3`               | unsound      | Build-only path through `tauri-utils -> kuchikiki -> selectors -> phf_generator`; fixed `rand 0.8.6` violates `phf_generator 0.8`'s constraint, and the custom-logger trigger is unused. [Advisory](https://rustsec.org/advisories/RUSTSEC-2026-0097.html) |
| `RUSTSEC-2025-0081` | `unic-char-property@0.9.0` | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0081.html)                                                                                         |
| `RUSTSEC-2025-0075` | `unic-char-range@0.9.0`    | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0075.html)                                                                                         |
| `RUSTSEC-2025-0080` | `unic-common@0.9.0`        | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0080.html)                                                                                         |
| `RUSTSEC-2025-0100` | `unic-ucd-ident@0.9.0`     | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0100.html)                                                                                         |
| `RUSTSEC-2025-0098` | `unic-ucd-version@0.9.0`   | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0098.html)                                                                                         |

## Explicit residual controls

The generated executables are not Authenticode-signed, Apple Developer
ID-signed/notarized, or Linux package-signed. Build provenance authenticates the
repository workflow and commit, but it is not a substitute for platform code
signing. Those controls require separately protected signing identities and
secrets.

Repository administrators must still protect `main`, require the CI and
security checks, restrict bypasses, protect the `production-release`
environment, and enable Dependabot alerts. These are external repository
settings and are intentionally not changed by workflow code.

GitHub Pages must stay on the built-in Jekyll build, sourced from `main` at
`/docs`. It publishes the documentation site, not the application. Switching
the source to Actions would break it: there is no longer a workflow that
publishes a Pages artifact, and the previous one deployed the web application
export over the documentation on every push.

The former `PAGES_ADMIN_TOKEN` bootstrap path is no longer used. Remove that
repository secret if it still exists.
