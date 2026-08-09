---
title: Home
nav_order: 1
permalink: /
description: Curated documentation for Better Cloudflare, a Cloudflare DNS console shipped as a Tauri v2 desktop application.
---

# Better Cloudflare documentation

Curated documentation for [Better Cloudflare](https://github.com/supermarsx/better-cloudflare) — a Cloudflare DNS console shipped as a Tauri v2 desktop application. Start at the [readme](https://github.com/supermarsx/better-cloudflare/blob/main/readme.md) for an overview and installation.

Generated API reference is written separately to `docs/api/`, so `npm run docs` never overwrites these guides.

## Start here

| Guide                                  | What it covers                                                  |
| -------------------------------------- | --------------------------------------------------------------- |
| **[Screens and features](screens.md)** | All 26 screens with screenshots and what you do on each         |
| [Architecture](architecture.md)        | The desktop shell, the 17 Rust crates, key frontend modules, CI |
| [Security model](security.md)          | Encryption, keyring storage, and the current limits             |

## Reference

| Guide                                                                                      | What it covers                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [Design system](design-system.md)                                                          | Token model, theming, glass/sunset UI conventions                  |
| [SPF and NAPTR notes](spf-naptr.md)                                                        | What the two formats contain, the guided builders, and the SPF CLI |
| [Future work](future-work.md)                                                              | Planned work — not released capability                             |
| [Project specification](https://github.com/supermarsx/better-cloudflare/blob/main/spec.md) | Target product contract, with implementation-status annotations    |

## For contributors

| Guide                         | What it covers                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| [Development](development.md) | Dev commands, the `node:test` runner, Rust tests, CI gates, and the screenshot harness |

## About the screenshots

Every image on this site uses synthetic demo data — a fictional "Harborline Freight Systems" on RFC 2606 `.test` domains with RFC 5737 and RFC 3849 documentation IP ranges. **No real account, zone or credential appears in any capture.**

## Current status at a glance

These are the things most likely to be assumed incorrectly:

- **Passkey login and registration do not work.** Both fail closed by design; only listing and deleting legacy credentials works, for recovery.
- **There is no AI assistant in the UI.** Four Rust crates and a React hook exist as groundwork, but nothing in the interface imports the hook.
- **Biometrics are macOS Touch ID only.** Windows Hello and Linux are not implemented.
- **The updater is disabled**, and there is no code signing or macOS notarization. Package-manager channels do not exist.
- **The desktop app is the only shipped target.** A browser-context storage path still exists in the source — it backs the frontend dev server and the jsdom tests — and it never persists credentials.
- **Secure storage has no in-memory fallback.** If the OS keyring is unavailable, operations fail rather than degrading silently.
- **The test runner is Node's built-in `node:test`** via `scripts/run-tests-seq.ts` — not Vitest or Jest. See [Development](development.md#the-unit-runner-is-nodetest-not-vitest-and-not-jest).
