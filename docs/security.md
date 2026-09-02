---
title: Security model
nav_order: 4
description: Encryption, keyring storage, and the current limits.
---

# Security model

What protects your Cloudflare credentials, and — just as important — what does not.

Better Cloudflare is a desktop application, and this page describes the desktop security model. That is the only model on offer: there is no supported hosted or browser deployment, and nothing here should be read as a guarantee about running the frontend anywhere other than the Tauri shell.

This page states limits plainly. If a security feature is absent or broken, it is listed here rather than omitted.

## Encryption

API keys are encrypted with **AES-256-GCM** under a key derived by **PBKDF2-HMAC-SHA256**.

| Parameter                     | Value                                  |
| ----------------------------- | -------------------------------------- |
| Envelope prefix               | `bc1:`                                 |
| Additional authenticated data | `better-cloudflare:crypto-envelope:v1` |
| Salt                          | 16 random bytes, per encryption        |
| Nonce                         | 12 random bytes                        |
| Authentication tag            | 16 bytes                               |
| Iterations                    | 100,000 – 1,000,000, user-configurable |
| Key length                    | 256 bits (fixed)                       |

Only the iteration count is yours to choose. The dialog below is the whole of the user-facing surface:

<img src="screenshots/dark/encryption-settings.png" width="620" alt="Encryption Settings modal: a PBKDF2 iterations field set to 310000 with its permitted range printed underneath, key length and algorithm selects that are visibly disabled, Benchmark and Update buttons, an Enable OS Vault switch, and the reading from the last benchmark run">

**Key length** and **algorithm** are rendered as disabled controls rather than hidden, so you can see what you are getting: 256-bit AES-GCM, not negotiable. **Iterations** is the free parameter, and the field is clamped to the range printed beneath it. **Benchmark** times one derivation at the current setting and reports the result, which is the honest way to pick a number — raise the count until unlock takes as long as you are willing to wait on the slowest machine you use, rather than copying a figure from a blog post.

**Enable OS Vault** stores decrypted keys in the system vault. It is what [passkey login](#passkeys) unlocks, so turn it on only if you intend to use one.

> **Limit: the iteration floor applies to encryption, not decryption.** A legacy decrypt path still reads older unversioned envelopes, which carry no AAD and may declare as few as one iteration. This exists so upgrades do not strand existing keys. Re-saving a key migrates it onto the `bc1:` envelope. Do not read "100,000 minimum" as a guarantee about data already on disk.

## Storage

### The OS keyring

Secrets go to the OS keyring — Keychain on macOS, Credential Manager on Windows, Secret Service on Linux.

Because keyring entries are size-limited, each logical secret is split into immutable chunks of at most 2000 bytes, tagged with a generation ID. A small manifest recording the generation, chunk count, byte length and a checksum is swapped only after every chunk has been read back and verified. An interrupted or failed write therefore leaves the previous generation intact and readable, rather than producing a half-updated secret.

### There is no in-memory fallback

This is worth stating explicitly, because it is easy to assume the opposite and the assumption is dangerous.

`Storage::default()` — the only constructor the application uses — **always** installs the keyring backend. The in-memory backend is reachable only through the explicit `Storage::new(false)` constructor, which in this repository is used solely by `bc-passkey` unit tests.

When the OS keyring is unavailable, secure-storage reads and writes **fail with an error**. Credentials are never silently relocated into process memory or written somewhere less protected. You will see visible failures loading or saving API keys, vault secrets, registrar credentials, the audit log and encryption settings.

On Linux this means a Secret Service provider (GNOME Keyring, KWallet, or equivalent) must be running and unlocked. Headless sessions frequently have none.

### Browser-context code paths

Worth knowing, because anyone reading `src/lib/storage` will find them: the frontend still contains a browser storage path. It is not a shipped product surface — it backs the `npm run dev` frontend server and the jsdom unit tests — but it is real code and it behaves safely.

**It never persists credentials.** Browser preference writes are validated against an allowlist schema (`BROWSER_PREFERENCE_SCHEMA` in `src/lib/storage/storage-util.ts`) that contains no `apiKeys` or `currentSession` keys, so credentials are dropped structurally — not by a filter that could be forgotten on a new code path, but because the serializer has nowhere to put them. `serializeForPersistence()` applies it on every persist.

The practical consequence: in a browser context a key exists only in memory for the session and is gone when the page closes. None of the guarantees above — keyring storage, chunked manifests, the encryption envelope at rest — apply there, because nothing is written at rest at all.

## Passkeys

Passkey **registration and authentication work**, against a verified WebAuthn relying party.

**Measured on Windows only.** A full register-then-authenticate round trip completes in the production WebView2 build at `http://tauri.localhost`, and the unlock token it mints releases a vault secret; a forged, replayed, or absent token does not. That was run against the shipped binary, not inferred from tests. What is written below about macOS and Linux is _expected_ rather than measured — see [Platforms](#platforms-what-is-verified-where).

They did not work for a period, and the reason matters. The implementation removed in `d05fe59` validated none of the things WebAuthn security depends on — not the clientDataJSON type or origin, not the RP ID hash, not the user-presence or user-verification flags, not the signature, not the authenticator counter. It compared the challenge it had issued against the challenge echoed back inside client-supplied JSON and called that verification. Rather than ship an authentication mechanism that only looked like one, it was removed and the whole path was made to fail closed.

What replaced it does not re-implement those checks either. `bc-passkey` drives both ceremonies through [`webauthn-rs`](https://github.com/kanidm/webauthn-rs)'s high-level API and stores what that library attests to: the COSE public key, the RP ID, and the signature counter. The type, origin, RP-ID-hash, flag, signature and counter checks are the library's, performed once, in one place. A parallel check alongside it could only ever be weaker than, or disagree with, the one that matters — hand-rolling them is exactly how the original flaw happened.

Around the library sit the parts a relying party has to get right itself:

- **Challenges** are server-issued and single-use — taken out of the store _before_ verification, so a failed attempt burns them — expire after 120 seconds, and are capped at 32 accounts in flight.
- **The relying party is scoped to the window's own origin**, read on the Rust side and never nominated by the page. `allow_subdomains(false)` and `allow_any_port(false)` are set explicitly. The RP ID is recorded on every credential, and an assertion whose credential was enrolled under a different one is refused with a message saying to re-enroll — a credential enrolled in a dev build genuinely cannot be used in a production build, and no configuration changes that.
- **The unlock token** a successful assertion produces is 32 bytes from the process CSPRNG, single-use, valid for 60 seconds, bound to one account, compared in constant time, never persisted and never logged. It has exactly one construction site, reachable only from the success path of an assertion the library verified — a compile-time obligation rather than a convention. The credential that signed is recorded alongside it but is not compared: at most one token is live per account and no caller presents a credential id, so there is nothing such a comparison could reject that the account check and single use do not.

`get_vault_secret`, which releases a decrypted API key, requires such a token and spends it. Every outcome — the release and each refusal — is written to the audit log, which records the operation, resource and result and never the token or the secret.

**Legacy credentials cannot sign in.** Records written before verified registration hold no public key, so nothing can be checked against them. They can be listed and deleted, and the UI says so and offers re-enrollment. That is not a migration that was skipped: the material verification needs was never captured.

### Platforms: what is verified where

The relying party is scoped to whatever origin the webview reports, and that string is not the same on every platform:

| Context                           | Origin                   | RP ID             | State                                                                          |
| --------------------------------- | ------------------------ | ----------------- | ------------------------------------------------------------------------------ |
| Production, Windows (WebView2)    | `http://tauri.localhost` | `tauri.localhost` | **Verified working**, end to end                                               |
| Development (`npm run tauri:dev`) | `http://localhost:3000`  | `localhost`       | Same code path; credentials enrolled here cannot be used in a production build |
| Production, macOS / Linux         | `tauri://localhost`      | `localhost`       | Relying party configures; **the client is expected to refuse**                 |

On macOS and Linux the backend is _not_ the thing that says no. `tauri://localhost` is a non-special scheme, but it still has a host, so a relying party builds and `status()` reports available. What decides is the frontend's own probe: a WebAuthn client that will not operate at an opaque origin makes `isUserVerifyingPlatformAuthenticatorAvailable()` fail or return false, and the login screen shows the `webview` cause below. **Nobody has run this on macOS or Linux** — the capability spike covered Windows only — so treat that row as the expected outcome and not as a measurement. It is stated this way deliberately: the honest failure mode of this design is that the UI depends on the client probe to avoid offering a button that cannot work, and that dependency has been exercised on one platform.

Windows production shares its RP ID, `tauri.localhost`, with every other Tauri application on the machine. That is inherent to Tauri's WebView2 origin rather than something this app chose, and it sits outside the threat model here (a single user's own machine) — recorded so it is a known property rather than a surprise.

### Four reasons passkeys can be unavailable, and four different messages

Collapsing these into one "passkeys unavailable" banner would tell you nothing you could act on, so each has its own text and its own visual tone:

| Cause                | What it means                                                                                                          | What you can do                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `backend`            | The relying party reports no capability — the origin could not be resolved into one. The message is the backend's own. | Nothing on this machine; it is a configuration fault                                    |
| `webview`            | The backend is willing, but this webview provides no WebAuthn client. The standing expectation on macOS and Linux.     | Use a password, or a different platform                                                 |
| `no-authenticator`   | Everything works, but no user-verifying platform authenticator is enrolled here.                                       | Enrol Windows Hello, Touch ID, or a device passcode                                     |
| `legacy-credentials` | The passkeys on file predate verified registration.                                                                    | Register a new passkey — this is the one unavailable state that still offers the button |

Only a resolution failure or a failed status call renders red. A platform limitation you cannot act on renders neutral, because painting it as a fault implies you could fix it.

**A passkey still needs a platform authenticator.** Where one of the above applies, the login screen names that specific reason rather than offering a button that fails:

<img src="screenshots/dark/login.png" width="620" alt="The authentication card: an API Key dropdown, a masked vault password field with an unmask button, a Login button, secondary Add New Key / Manage Key / Settings buttons, and a Passkey security status panel">

### The library is pinned to a pre-release, knowingly

`bc-passkey` depends on `webauthn-rs = "=0.6.1-dev"`. **That is a pre-release crypto library in a credential-verification path, and it was accepted rather than resolved.** There is no released 0.6.x — `0.6.1-dev` (published 2026-04-30) is the only 0.6 publication in existence — so this is not a pin that could be tightened to a stable version today.

It was chosen against a specific alternative, not by default. The 0.5 line depends on `openssl` and `openssl-sys` unconditionally, with no feature to opt out. In this workspace OpenSSL otherwise enters the build graph on **Linux only**, via `reqwest → hyper-tls → native-tls`; Windows uses schannel and macOS uses security-framework. Taking 0.5 would have made a native OpenSSL a first-time build requirement on two more platforms and linked it into the shipped binary — and `native-tls` is used here precisely so the platform decides what crypto the binary links. A passkey library smuggling a different answer in through the back door was judged the worse of the two risks. The 0.6 line replaces OpenSSL with RustCrypto.

The `=` is exact for two independent reasons: Cargo will not select a pre-release from `version = "0.6"` at all, and even spelled without the `=` a caret requirement would drift to the next `-dev` publication — which carry no compatibility promise, in code that verifies credentials. The sibling crates (`webauthn-rs-core`, `webauthn-rs-proto`, `webauthn-attestation-ca`) are not declared directly; upstream already pins each at exactly `=0.6.1-dev`, and `Cargo.lock` records them all.

`default-features = false` drops the default-on `attestation` feature: the conveyance policy is `None`, with no device allowlist and no maintained FIDO MDS trust store, so that machinery is unused. **No attestation is not no verification** — registration is still bound by a server-issued single-use challenge, an origin check, and an RP-ID-hash check. The three `danger-*` features are off and must stay off.

**Intended endpoint:** move to the stable 0.6.x when it ships, drop the `=` to a caret requirement, and re-run the full ceremony suite as part of that change. A related consequence is recorded under [dependency exceptions](../.github/RELEASE_SECURITY.md): `RUSTSEC-2023-0071` (`rsa`, Marvin timing side-channel) reaches this graph transitively through `webauthn-rs → crypto-glue`, has no patched release in any line, and is accepted on the grounds that a relying party holds no RSA private key and decrypts nothing.

This is also the screen where the credential-unlock model is visible in one glance. Nothing is decrypted at rest by the act of selecting a key: you pick a stored credential from **API Key**, and the vault password you type is what derives the PBKDF2 key that unwraps it. The password is never stored — losing it means losing access to that key, which is the intended property.

The three secondary buttons add a key, edit or delete an existing one (deletion is confirm-gated), and open the [encryption settings](#encryption) dialog.

Biometric unlock only appears on this screen on macOS, where Touch ID is the sole implemented runtime — see [Biometrics](#biometrics) below.

## Biometrics

**macOS Touch ID only.**

`bc-biometrics` compiles a `macos` module on macOS and a `fallback` module everywhere else; the fallback returns `PlatformNotSupported` for every operation and reports `available: false`. Windows Hello and Linux are **not implemented** — the `BiometricType::WindowsHello` enum variant exists but is unreachable, and a doc comment in that crate overstates support.

## MCP server

The local MCP server is **off by default**. When enabled it binds `127.0.0.1:8787` by default, speaks JSON-RPC at protocol version `2024-11-05`, and requires a bearer token.

Authorisation is per tool, not per server:

<img src="screenshots/dark/mcp-tool-permissions.png" width="720" alt="MCP settings: server status with its local URL, an enable switch, bind host and port fields with an Apply and restart button, and a searchable per-tool permission list whose summary reads 34 of 53 classified tools enabled, with tools grouped by category and carrying risk labels such as CREDENTIAL ACCESS">

Granting the server access is not one decision but many. Each tool is classified by capability, category and risk, the summary line keeps the count of what is actually enabled visible ("N of M classified tools enabled"), and the risk labels — `CREDENTIAL ACCESS` and its peers — are attached to the individual rows rather than buried in a description.

Enabling any write, bulk, destructive, credential-touching or administrative tool raises a modal listing exactly what you are about to grant and requires explicit confirmation. **Unclassified tools are always denied** and cannot be enabled — an unrecognised tool fails closed rather than inheriting a permissive default, so adding a tool to the backend does not silently expose it.

## Distribution

- **The auto-updater is disabled.** `tauri.conf.json` sets `"updater": { "active": false }`. The desktop app does not self-update.
- **There is no code signing and no macOS notarization.** `certificateThumbprint` is `null` and the macOS block configures no signing identity or notarization. Bundles produced by `npm run tauri:build` are unsigned.
- **There is no package-manager distribution.** No Homebrew, Chocolatey, WinGet, Flathub or Snap channel exists. This is future work.

Do not describe release artifacts as signed, notarized, auto-updating or package-manager-installable.

## Supply chain

The `release_contract` CI job runs an OSV scan across both `package-lock.json` and `Cargo.lock`, behind a fail-closed policy validator, and release is gated on it along with the format, lint, unit, e2e, native and packaging jobs.

## See also

- [Architecture](architecture.md) — storage internals and the crate map
- [Screens and features](screens.md) — the login, encryption and MCP screens
- [Development](development.md) — how CI enforces the supply-chain gate above
