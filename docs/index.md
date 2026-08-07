# Better Cloudflare documentation

Curated documentation for [Better Cloudflare](https://github.com/supermarsx/better-cloudflare) — a Cloudflare DNS console shipped as a static web preview and a Tauri desktop app. Start at the [README](../README.md) for an overview and installation.

Generated API reference is written separately to `docs/api/`, so `npm run docs` never overwrites these guides.

## Start here

| Guide                                  | What it covers                                               |
| -------------------------------------- | ------------------------------------------------------------ |
| **[Screens and features](screens.md)** | All 26 screens with screenshots and what you do on each      |
| [Architecture](architecture.md)        | The two builds, the 17 Rust crates, key frontend modules, CI |
| [Security model](security.md)          | Encryption, keyring storage, and the current limits          |

## Reference

| Guide                                       | What it covers                                                    |
| ------------------------------------------- | ----------------------------------------------------------------- |
| [Tauri migration guide](tauri-migration.md) | Desktop backend, Tauri command reference, build and bundle output |
| [Design system](design-system.md)           | Token model, theming, glass/sunset UI conventions                 |
| [SPF and NAPTR notes](spf-naptr.md)         | Record-format reference and the `npm run check-spf` CLI           |
| [Future work](future-work.md)               | Planned work — not released capability                            |
| [Project specification](../spec.md)         | Target product contract, with implementation-status annotations   |

## Retired

| Document                                        | Status                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Passkey architecture](passkey-architecture.md) | **Retired.** Describes an Express/SQLite server design that was never the desktop implementation. Do not infer current passkey behaviour from it — see [Security](security.md#passkeys-are-disabled). |

## Screenshots

`docs/screenshots/` holds every screen in `dark/` (the default sunset theme) and `light/`, plus the records table in `oled/`. All images use synthetic data — a fictional "Harborline Freight Systems" on RFC 2606 `.test` domains with RFC 5737 and RFC 3849 documentation IPs. No real account, zone or credential appears in any capture.

Regenerate them with `npm run screenshots`, optionally narrowed with `--only=<names>` or `--theme=<themes>`.

## Current status at a glance

These are the things most likely to be assumed incorrectly:

- **Passkey login and registration do not work.** Both fail closed by design; only listing and deleting legacy credentials works, for recovery.
- **There is no AI assistant in the UI.** Four Rust crates and a React hook exist as groundwork, but nothing in the interface imports the hook.
- **Biometrics are macOS Touch ID only.** Windows Hello and Linux are not implemented.
- **The updater is disabled**, and there is no code signing or macOS notarization. Package-manager channels do not exist.
- **The web build never persists credentials**, so it does not offer the desktop security model. It is a preview.
- **Secure storage has no in-memory fallback.** If the OS keyring is unavailable, operations fail rather than degrading silently.
- **The test runner is Node's built-in `node:test`** via `scripts/run-tests-seq.ts` — not Vitest or Jest.
