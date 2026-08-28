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
- `openssl`, `serde_with`, Tauri, and its build/plugin/runtime packages remain
  at or above their remediated security floors;
- both workflows retain both lockfiles, the config, the pinned scanner image,
  and no `continue-on-error`.

An unfiltered diagnostic scan using an empty config override reports 19
affected Rust packages: 18 maintenance-only notices and one unsoundness
advisory. OSV lists a nominal fixed version for `glib`, but it is not
solver-reachable in the current Tauri stack: `gtk 0.18` requires
`glib ^0.18`. Replacing that dependency family requires an upstream
Tauri/GTK migration rather than a safe lockfile update.

`RUSTSEC-2025-0057` (`fxhash@0.2.1`) and `RUSTSEC-2026-0097` (`rand@0.7.3`)
were retired rather than renewed. `tauri-plugin 2.6.3` selects the
`tauri-utils` `build-2` feature, which replaces the archived
`kuchikiki -> selectors -> phf_generator` HTML stack with `dom_query`; both
packages, and 37 others, left the lockfile entirely (688 -> 649 packages).
The validator's `tauri-plugin` floor exists to stop a downgrade from
resurrecting them.

### OSV exception register

Owner for every entry: Better Cloudflare security maintainers. Review and
expiry date for every entry: 2026-10-30.

| ID                  | Package                    | Class        | Rationale and upstream reference                                                                                                                                              |
| ------------------- | -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUSTSEC-2024-0413` | `atk@0.18.2`               | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0413.html)                             |
| `RUSTSEC-2024-0416` | `atk-sys@0.18.2`           | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0416.html)                             |
| `RUSTSEC-2024-0388` | `derivative@2.2.0`         | unmaintained | Maintenance-only notice through `keyring -> secret-service -> zbus`; no compatible keyring-stack removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0388.html)   |
| `RUSTSEC-2024-0412` | `gdk@0.18.2`               | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0412.html)                             |
| `RUSTSEC-2024-0418` | `gdk-sys@0.18.2`           | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0418.html)                             |
| `RUSTSEC-2024-0411` | `gdkwayland-sys@0.18.2`    | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0411.html)                             |
| `RUSTSEC-2024-0417` | `gdkx11@0.18.2`            | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0417.html)                             |
| `RUSTSEC-2024-0414` | `gdkx11-sys@0.18.2`        | unmaintained | Archived GTK3 binding, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0414.html)                             |
| `RUSTSEC-2024-0429` | `glib@0.18.5`              | unsound      | No direct application use; fixed `glib 0.20` is incompatible with Tauri's `gtk 0.18` requirement. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)           |
| `RUSTSEC-2024-0415` | `gtk@0.18.2`               | unmaintained | Archived GTK3 binding, transitively required by Tauri's Linux runtime; GTK4 is a runtime migration. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0415.html)         |
| `RUSTSEC-2024-0420` | `gtk-sys@0.18.2`           | unmaintained | Archived GTK3 binding, transitively required by Tauri's Linux runtime; GTK4 is a runtime migration. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0420.html)         |
| `RUSTSEC-2024-0419` | `gtk3-macros@0.18.2`       | unmaintained | Archived GTK3 build dependency, transitively required by Tauri; no patched GTK3 release. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0419.html)                    |
| `RUSTSEC-2024-0384` | `instant@0.1.13`           | unmaintained | Maintenance-only notice through `keyring -> secret-service -> zbus -> futures-lite`; no compatible removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0384.html) |
| `RUSTSEC-2024-0370` | `proc-macro-error@1.0.4`   | unmaintained | Maintenance-only GTK3 macro build dependency; no compatible Tauri GTK3 removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)                             |
| `RUSTSEC-2025-0081` | `unic-char-property@0.9.0` | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0081.html)            |
| `RUSTSEC-2025-0075` | `unic-char-range@0.9.0`    | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0075.html)            |
| `RUSTSEC-2025-0080` | `unic-common@0.9.0`        | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0080.html)            |
| `RUSTSEC-2025-0100` | `unic-ucd-ident@0.9.0`     | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0100.html)            |
| `RUSTSEC-2025-0098` | `unic-ucd-version@0.9.0`   | unmaintained | Maintenance-only `tauri-utils -> urlpattern` dependency; no compatible `urlpattern 0.3` removal. [Advisory](https://rustsec.org/advisories/RUSTSEC-2025-0098.html)            |

## Secret scanning gate

GitHub's native secret scanning and push protection are enabled on this public
repository. Native scanning is an alert stream and a push-time block, not a
pull-request status check, its non-provider (generic) patterns are disabled, and
its partner pattern set does not cover Porkbun, Namecheap, Name.com or this
application's own MCP bearer tokens. The `secrets` job in
`.github/workflows/security.yml` therefore adds a merge-blocking check with a
repository-specific rule set rather than replacing the native control.

The job runs Gitleaks 8.30.1, fetched by version from the upstream release and
rejected unless the archive hashes to
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`. Pull
requests scan only the commits the pull request adds
(`--log-opts="--no-merges $PR_BASE_SHA..$PR_HEAD_SHA"`); every other event
scans the full history. Neither invocation uses a baseline, a rule filter or a
softened exit code, and the job needs no repository secrets, so it behaves
identically for pull requests from forks.

Before scanning, `.github/scripts/validate-secret-policy.py` fails closed
unless:

- the policy lives at `.github/gitleaks.toml` and extends, rather than
  replaces, the upstream Gitleaks ruleset;
- the rule identifiers are exactly the reviewed set below, each with a
  description, a compiling regex and lowercase keywords;
- global allowlists suppress by path only, so no value-shaped or entropy-shaped
  blanket suppression can be introduced;
- the allowlist path set is exactly the reviewed set below and no entry matches
  any protected canary path under `src/`, `src-tauri/`, `test/`, `docs/`,
  `app/`, `scripts/`, `.github/workflows/` or a dotenv file;
- every fingerprint in `.gitleaksignore` is well-formed, unique, in the reviewed
  set below, and documented there — Gitleaks reads that file automatically, so
  without this check it would be a second, unreviewed suppression channel
  sitting beside the policy;
- the registers below still name their owner and their unexpired review date
  and document every rule, every allowlist path and every fingerprint;
- the workflow retains the pinned version, the pinned digest, the digest
  verification, the diff/history split, the reviewed ignore-file path and no
  `continue-on-error`.

### Secret scanning rule register

Owner for every entry: Better Cloudflare security maintainers. Review and
expiry date for every entry: 2026-10-30.

The upstream Gitleaks ruleset already covers `cloudflare-api-key`,
`cloudflare-global-api-key`, `cloudflare-origin-ca-key`, `anthropic-api-key`,
`anthropic-admin-api-key`, `openai-api-key`, `gcp-api-key` and the generic
high-entropy rules. Each rule below closes a gap that ruleset leaves for the
credentials this application handles.

| Rule                           | Credential                                                                | Gap it closes                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bc-cloudflare-api-token`      | Cloudflare scoped API token (40 URL-safe base64 characters)               | Upstream needs the literal word "cloudflare" beside the value, so `CF_API_TOKEN=` in a dotenv or CI file is missed. |
| `bc-cloudflare-global-api-key` | Cloudflare Global API key (37 lowercase hex characters)                   | Same keyword limitation; this rule keys on the `X-Auth-Key` header the registrar client actually sends.             |
| `bc-cloudflare-auth-email`     | Cloudflare account e-mail paired with a Global API key                    | The paired `X-Auth-Email` value is half of the credential and has no upstream rule at all.                          |
| `bc-porkbun-api-key`           | Porkbun `pk1_<64 hex>` API key and `sk1_<64 hex>` secret key              | No upstream Porkbun rule exists.                                                                                    |
| `bc-godaddy-sso-key`           | GoDaddy `sso-key <key>:<secret>` authorization pair                       | No upstream GoDaddy rule exists.                                                                                    |
| `bc-namecheap-api-key`         | Namecheap `ApiKey` (32 hex) presented with its `ApiUser`                  | No upstream Namecheap rule exists.                                                                                  |
| `bc-name-com-api-token`        | Name.com API token                                                        | No upstream Name.com rule exists.                                                                                   |
| `bc-mcp-bearer-token`          | Bearer token protecting this application's MCP server                     | An application-specific credential with no vendor rule anywhere.                                                    |
| `bc-ai-provider-api-key`       | Anthropic `sk-ant-<prefix>-` variants and legacy 48-character OpenAI keys | Upstream pins `api03`/`admin01` and the modern `T3BlbkFJ` shapes only.                                              |

`bc-cloudflare-auth-email` carries the only value-shaped allowlist in the
policy: addresses in the RFC 2606 / RFC 6761 reserved domains (`example.com`,
`example.net`, `example.org`, `.test`, `.invalid`, `.localhost`, `.local`)
cannot identify a real Cloudflare account.

### Secret scanning allowlist register

Owner for every entry: Better Cloudflare security maintainers. Review and
expiry date for every entry: 2026-10-30.

Every entry is path-scoped to a named file or to a git-ignored generated tree.
There is deliberately no entry that suppresses "anything under `test/`" or
"anything that looks like a fixture": the repository's fixture credentials
(`e2e/auth-errors.spec.ts`, `e2e/login-key-management.spec.ts`, the Rust test
tokens and the documentation examples) are written as obviously fake strings
and are expected to survive a scan unsuppressed.

| Path pattern                        | Class              | Rationale                                                                                                                                                                                                               |
| ----------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `(^\|/)node_modules/`               | generated          | Installed dependencies; git-ignored, so nothing here can reach a commit. Excluding it keeps a local `gitleaks dir` run equivalent to the CI git scan.                                                                   |
| `(^\|/)target/`                     | generated          | Cargo build output; git-ignored.                                                                                                                                                                                        |
| `^\.next/`                          | generated          | Next.js build cache; git-ignored.                                                                                                                                                                                       |
| `^out/`                             | generated          | Static export output; git-ignored.                                                                                                                                                                                      |
| `^dist(-ssr)?/`                     | generated          | Legacy bundler output; git-ignored.                                                                                                                                                                                     |
| `^test-results/`                    | generated          | Playwright evidence; git-ignored.                                                                                                                                                                                       |
| `^data/`                            | generated          | Local application state, which is the one place a real credential legitimately exists on a developer machine; git-ignored.                                                                                              |
| `^package-lock\.json$`              | integrity digest   | Every high-entropy string is a published npm integrity hash. Contents are fully determined by `package.json`.                                                                                                           |
| `^Cargo\.lock$`                     | integrity digest   | Every high-entropy string is a published crate checksum. Contents are fully determined by `Cargo.toml`.                                                                                                                 |
| `^e2e/fixtures/demo-workspace\.ts$` | screenshot fixture | Fictional by construction: RFC 2606 `.test` domains, RFC 5737/3849 documentation IP blocks, and literal placeholders (`demo-ciphertext`, `demo-token-not-a-real-credential`). Scoped to this exact file, not to `e2e/`. |
| `^e2e/fixtures/demo-panels\.ts$`    | screenshot fixture | Same harness, same construction. Scoped to this exact file.                                                                                                                                                             |
| `^\.github/gitleaks\.toml$`         | policy             | The policy necessarily spells out the credential shapes it detects.                                                                                                                                                     |

### Secret scanning fingerprint register

Owner for every entry: Better Cloudflare security maintainers. Review and
expiry date for every entry: 2026-10-30.

Entries live in `.gitleaksignore`. A Gitleaks fingerprint is
`<commit>:<path>:<rule>:<line>` in `git` mode, which is what CI runs, and
`<path>:<rule>:<line>` in `dir` mode. Either way one entry pins a single rule
firing on a single line of a single file — and in `git` mode, in a single
historical commit. That is narrower than anything the policy file can express:
it cannot hide the same value in another commit, or the same line under another
rule. The validator rejects any entry that is not exactly one of those two
shapes, so an entry cannot be widened into a glob.

Fingerprints exist only because the push scan reads commit patches and history
is immutable. A finding introduced by an old commit cannot be edited away: the
old patch still contains the value, and the removal line in the new commit is
itself scanned, which adds a second finding instead of clearing the first.
Anything that _can_ be fixed at the source must be fixed there instead, so this
register is expected to stay near-empty.

Suppressing one of these findings by path instead was considered and rejected:
a path entry blinds every rule to a whole file forever, and the file here is
production parser source. `src-tauri/crates/bc-dns-tools/src/import.rs` is
therefore listed among the validator's protected canary paths, which keeps the
broad form permanently unavailable — an allowlist path matching it fails the
gate.

**Retiring an entry.** An entry becomes retirable only when the commit it names
leaves the scanned history, which for published history means it does not. If
that ever happens — a history rewrite, or the repository being re-created — drop
the line from `.gitleaksignore`, drop it from `APPROVED_FINGERPRINTS`, drop its
row here, and record the retirement in prose the way the OSV register does. The
validator requires the file and the reviewed set to agree in both directions, so
a half-finished retirement fails the gate rather than silently widening or
narrowing the scan.

| Fingerprint                                                                                                 | Class        | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `5972d00ab057c78d95c73e55bc36191777b28916:src-tauri/crates/bc-dns-tools/src/import.rs:generic-api-key:1123` | test fixture | The OPENPGPKEY row of the `#[cfg(test)]` DNS record-type fixture table, beside the DNSKEY, DS, SMIMEA and TLSA fixtures. The value is a fabricated OpenPGP public-key blob: it decodes to the packet header `99 02 0d 04` — which is why every real key block starts `mQINB` — followed by the ASCII text `dandomKeyDataForTestingOnly`. It holds no key material and never did; upstream `generic-api-key` fires only because a quoted base64 blob measures 4.7 bits of entropy. Not path-allowlisted, because `import.rs` is production parser source and a path entry would blind every rule to that whole file. This is the entry that makes CI pass. |
| `src-tauri/crates/bc-dns-tools/src/import.rs:generic-api-key:1123`                                          | test fixture | The same fixture row, as fingerprinted by `gitleaks dir`. CI never runs `dir` mode, so this entry is not needed for the gate; it keeps a local working-tree run clean so that a developer is not met by a finding whose obvious fix — editing the value — is the one change that makes CI worse rather than better.                                                                                                                                                                                                                                                                                                                                       |

Verified with Gitleaks 8.30.1: with this policy and this fingerprint register
the scan reports zero findings against both the full commit history and the
working tree. Verified to still have teeth: reintroducing the identical value in
a new commit is reported, because that is a different commit and therefore a
different fingerprint.

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
